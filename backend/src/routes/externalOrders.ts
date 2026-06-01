import { Router } from 'express';
import multer from 'multer';
import { Op } from 'sequelize';
import {
  sequelize,
  ExternalOrder,
  ExternalOrderItem,
  ExternalOrderTender,
  TransactionOrderLink,
} from '../models';
import { currentAuth } from '../auth/middleware';
import { logger } from '../observability/logger';
import {
  extractReceiptFromImage,
  extractReceiptFromText,
  type ExtractedReceiptOrder,
} from '../ai/extractReceiptItems';
import { parsePurchaseHistoryCsv } from '../import/parsePurchaseHistoryCsv';
import { extractPdfLines } from '../import/pdf/extractLines';
import {
  findReceiptPdfParser,
  registerBuiltInReceiptPdfParsers,
} from '../import/pdf/receipts/registry';
import { matchReceiptOrderToTransactions } from '../import/matchReceiptToTransactions';
import { aiSuggestLimiter } from './aiRateLimit';
import { importUploadLimiter } from './importRateLimit';
import { rejectDemoAiRequest } from '../demo/aiAccess';

const router = Router();

type LinkStatus = 'linked' | 'needs_match' | 'orphan';

function deriveLinkStatus(links: TransactionOrderLink[] | undefined): LinkStatus {
  const list = links ?? [];
  if (list.some((l) => l.status === 'accepted')) return 'linked';
  if (list.some((l) => l.status === 'suggested')) return 'needs_match';
  return 'orphan';
}

function serializeOrderWithLinkStatus(order: ExternalOrder) {
  const json = order.toJSON() as Record<string, unknown>;
  const linkStatus = deriveLinkStatus(
    order.get('transactionLinks') as TransactionOrderLink[] | undefined,
  );
  delete json.transactionLinks;
  return { ...json, linkStatus };
}

/**
 * GET /api/external-orders?group=all|gmail|amazon|other&limit=50
 *
 * Vendor-agnostic list of captured receipts/orders for the caller's household,
 * each annotated with its match status to card transactions. The canonical
 * read surface behind the /receipts page.
 */
router.get('/', async (req, res, next) => {
  try {
    const { household } = currentAuth(req);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
    const group = String(req.query.group ?? 'all').toLowerCase();

    const where: Record<string, unknown> = { householdId: household.id };
    if (group === 'gmail') {
      where.source = { [Op.like]: 'gmail-scan:%' };
    } else if (group === 'amazon') {
      where.vendor = 'amazon';
    } else if (group === 'other') {
      where.source = { [Op.notLike]: 'gmail-scan:%' };
      where.vendor = { [Op.ne]: 'amazon' };
    }

    const orders = await ExternalOrder.findAll({
      where: where as never,
      include: [
        { model: ExternalOrderItem, as: 'items' },
        { model: TransactionOrderLink, as: 'transactionLinks', required: false },
      ],
      order: [
        ['orderDate', 'DESC'],
        ['id', 'DESC'],
      ],
      limit,
    });

    res.json(orders.map(serializeOrderWithLinkStatus));
  } catch (e) {
    next(e);
  }
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
});

const pdfUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 16 * 1024 * 1024 },
});

/** Wrap a multer single-field handler in an Express-friendly middleware that forwards errors via next(). */
function singleFile(uploader: ReturnType<typeof multer>, fieldName: string) {
  return (req: import('express').Request, res: import('express').Response, next: import('express').NextFunction) => {
    uploader.single(fieldName)(req as never, res as never, (err: unknown) => {
      if (err) return next(err);
      next();
    });
  };
}

type UploadedFile = { mimetype: string; buffer: Buffer; originalname: string };

/** Extract the multer-parsed `file` from the request, sending 400 if missing. Returns null when missing. */
function requireUploadedFile(req: import('express').Request, res: import('express').Response): UploadedFile | null {
  const file = (req as unknown as { file?: UploadedFile }).file;
  if (!file) {
    res.status(400).json({ error: 'file is required' });
    return null;
  }
  return file;
}

export async function persistExtractedOrder(
  extracted: ExtractedReceiptOrder,
  opts: { userId: number | null; householdId: number | null; source: string },
): Promise<{ order: ExternalOrder; created: boolean }> {
  if (extracted.total == null && extracted.items.length === 0) {
    const err = new Error('Receipt extraction returned no usable data') as Error & {
      status?: number;
    };
    err.status = 422;
    throw err;
  }

  // Dedupe key: vendor + orderId when known, otherwise a stable digest of
  // (date, total, item count). Avoids creating duplicate orders if the user
  // pastes the same receipt twice.
  const dedupeKey = [
    extracted.vendor,
    extracted.orderId || '',
    extracted.orderDate || '',
    extracted.total != null ? String(extracted.total) : '',
    String(extracted.items.length),
  ].join(':');

  return sequelize.transaction(async (t) => {
    const [order, created] = await ExternalOrder.findOrCreate({
      where:
        opts.householdId != null
          ? { householdId: opts.householdId, dedupeKey }
          : { dedupeKey },
      defaults: {
        householdId: opts.householdId,
        createdByUserId: opts.userId,
        vendor: extracted.vendor,
        vendorOrderId: extracted.orderId,
        dedupeKey,
        orderDate: extracted.orderDate,
        shipmentDate: null,
        subtotal: extracted.subtotal != null ? String(extracted.subtotal) : null,
        tax: extracted.tax != null ? String(extracted.tax) : null,
        shipping: null,
        total: extracted.total != null ? String(extracted.total) : null,
        currency: extracted.currency ?? 'USD',
        paymentLast4: extracted.paymentLast4,
        source: opts.source,
        rawPayload: extracted as unknown,
      } as never,
      transaction: t,
    });
    if (created && extracted.items.length > 0) {
      await ExternalOrderItem.bulkCreate(
        extracted.items.map((it) => ({
          externalOrderId: order.id,
          title: it.title,
          quantity: it.quantity,
          unitPrice: it.unitPrice != null ? String(it.unitPrice) : null,
          totalPrice: it.totalPrice != null ? String(it.totalPrice) : null,
          inferredCategory: it.inferredCategory,
          businessUsePercent: null,
          confidence: null,
          rawPayload: it as unknown,
        })) as never[],
        { transaction: t },
      );
    }
    if (created && extracted.tenders.length > 0) {
      await ExternalOrderTender.bulkCreate(
        extracted.tenders.map((tender, idx) => ({
          externalOrderId: order.id,
          sequence: idx,
          paymentLast4: tender.paymentLast4,
          network: tender.network,
          amount: String(tender.amount),
        })) as never[],
        { transaction: t },
      );
    }
    return { order, created };
  });
}

/**
 * POST /api/external-orders/match-unlinked
 *
 * Runs the receipt→transaction matcher against every ExternalOrder in this
 * household that has no TransactionOrderLink rows (orphans). Useful for
 * back-filling orders that were created before the auto-link was wired in.
 *
 * Capped at 1000 orders per call to bound runtime.
 *
 * Returns: { processed, linksCreated }
 */
router.post('/match-unlinked', async (req, res, next) => {
  try {
    const { household } = currentAuth(req);
    const householdId = household.id;

    // Orphan = no TransactionOrderLink rows for this order.
    // Use NOT EXISTS subquery to avoid GROUP BY / HAVING complexity with Sequelize includes.
    const orphans = await ExternalOrder.findAll({
      where: {
        householdId,
        [Op.and]: [
          sequelize.literal(
            `NOT EXISTS (SELECT 1 FROM "transaction_order_links" tol WHERE tol.external_order_id = "ExternalOrder"."id")`,
          ),
        ],
      },
      limit: 1000,
    } as never);

    let processed = 0;
    let linksCreated = 0;

    for (const order of orphans) {
      try {
        const result = await matchReceiptOrderToTransactions({
          externalOrderId: order.id,
          householdId,
        });
        linksCreated += result.created;
        processed += 1;
      } catch (err) {
        logger.warn({ err, orderId: order.id }, 'match_unlinked_order_failed');
        processed += 1;
      }
    }

    logger.info({
      householdId,
      processed,
      linksCreated,
    }, 'match_unlinked_complete');

    res.json({ processed, linksCreated });
  } catch (e) {
    next(e);
  }
});

/**
 * POST /api/external-orders/import-text
 * Body: { text: string }
 * Returns: { order, created, extracted }
 */
router.post('/import-text', aiSuggestLimiter, async (req, res, next) => {
  try {
    if (rejectDemoAiRequest(req, res)) return;
    const auth = currentAuth(req);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const text = typeof body.text === 'string' ? body.text : '';
    if (!text.trim()) {
      res.status(400).json({ error: 'text body is required' });
      return;
    }

    const extracted = await extractReceiptFromText(text);
    const { order, created } = await persistExtractedOrder(extracted, {
      userId: auth.user.id,
      householdId: auth.household.id,
      source: 'email-paste',
    });

    logger.info({
      source: 'email-paste',
      orderId: order.id,
      created,
      vendor: extracted.vendor,
      items: extracted.items.length,
      householdId: auth.household.id,
    }, 'external_order_imported');

    res.json({ order: order.toJSON(), created, extracted });
  } catch (e) {
    next(e);
  }
});

/**
 * POST /api/external-orders/import-image
 * multipart with field `file` (image/png|jpg|webp)
 * Returns: { order, created, extracted }
 */
router.post(
  '/import-image',
  aiSuggestLimiter,
  singleFile(upload, 'file'),
  async (req, res, next) => {
    try {
      if (rejectDemoAiRequest(req, res)) return;
      const auth = currentAuth(req);
      const file = requireUploadedFile(req, res);
      if (!file) return;
      const mime = (file.mimetype || '').toLowerCase();
      if (!mime.startsWith('image/')) {
        res.status(400).json({ error: 'only image/* uploads are supported (PNG, JPG, WebP)' });
        return;
      }
      const dataUrl = `data:${mime};base64,${file.buffer.toString('base64')}`;
      const extracted = await extractReceiptFromImage(dataUrl);
      const { order, created } = await persistExtractedOrder(extracted, {
        userId: auth.user.id,
        householdId: auth.household.id,
        source: 'image-upload',
      });
      logger.info({
        source: 'image-upload',
        orderId: order.id,
        created,
        vendor: extracted.vendor,
        items: extracted.items.length,
        householdId: auth.household.id,
      }, 'external_order_imported');
      res.json({ order: order.toJSON(), created, extracted });
    } catch (e) {
      next(e);
    }
  },
);

/**
 * POST /api/external-orders/import-csv?vendor=apple|google|amazon|other
 *
 * Bulk import via vendor purchase-history CSV (Apple report-a-problem
 * export, Google Pay/Takeout, etc.). Each CSV row becomes one ExternalOrder
 * with one item. Headers are mapped heuristically by name; rows with no
 * recognisable title or amount are skipped.
 *
 * multipart field 'file' = the CSV.
 * Returns: { vendor, totalRows, createdOrders, skippedDuplicates, errors }
 */
router.post(
  '/import-csv',
  importUploadLimiter,
  singleFile(upload, 'file'),
  async (req, res, next) => {
    try {
      const auth = currentAuth(req);
      const file = requireUploadedFile(req, res);
      if (!file) return;
      const vendor = (() => {
        const raw = String(req.query.vendor ?? '').toLowerCase();
        if (raw === 'apple' || raw === 'google' || raw === 'amazon' || raw === 'other') {
          return raw as ExtractedReceiptOrder['vendor'];
        }
        return 'other';
      })();

      const text = file.buffer.toString('utf8');
      const parsed = parsePurchaseHistoryCsv(text, { vendor, defaultCurrency: 'USD' });

      let created = 0;
      let duplicates = 0;
      const errors: Array<{ rowIndex: number; message: string }> = [];

      for (let i = 0; i < parsed.orders.length; i++) {
        const order = parsed.orders[i];
        try {
          const result = await persistExtractedOrder(order, {
            userId: auth.user.id,
            householdId: auth.household.id,
            source: `${vendor}-csv`,
          });
          if (result.created) created++;
          else duplicates++;
        } catch (e) {
          errors.push({
            rowIndex: i,
            message: e instanceof Error ? e.message : 'persist failed',
          });
        }
      }

      logger.info({
        source: `${vendor}-csv`,
        vendor,
        totalRows: parsed.totalRows,
        ordersBuilt: parsed.orders.length,
        unparsedRows: parsed.unparsedRows,
        created,
        duplicates,
        errored: errors.length,
        householdId: auth.household.id,
      }, 'external_order_csv_imported');

      res.json({
        vendor,
        fileName: file.originalname,
        totalRows: parsed.totalRows,
        ordersBuilt: parsed.orders.length,
        unparsedRows: parsed.unparsedRows,
        createdOrders: created,
        skippedDuplicates: duplicates,
        errors,
        columnMapping: parsed.columnMapping,
      });
    } catch (e) {
      next(e);
    }
  },
);

/**
 * POST /api/external-orders/import-pdf
 * multipart with field `file` (application/pdf)
 * Routes the PDF through the receipt parser registry (currently Costco till
 * receipts). Returns: { order, created, extracted, warnings, parserId }
 */
router.post(
  '/import-pdf',
  importUploadLimiter,
  singleFile(pdfUpload, 'file'),
  // Sequential validation + parse + persist + match; covered by integration tests.
  // fallow-ignore-next-line complexity
  async (req, res, next) => {
    try {
      const auth = currentAuth(req);
      const file = requireUploadedFile(req, res);
      if (!file) return;
      const mime = (file.mimetype || '').toLowerCase();
      const looksLikePdf = mime === 'application/pdf' || /\.pdf$/i.test(file.originalname);
      if (!looksLikePdf) {
        res.status(400).json({ error: 'only application/pdf uploads are supported' });
        return;
      }

      const lines = await extractPdfLines(file.buffer);
      registerBuiltInReceiptPdfParsers();
      const parser = findReceiptPdfParser(lines);
      if (!parser) {
        res.status(422).json({ error: 'no receipt parser matched this PDF' });
        return;
      }

      const { extracted, warnings } = parser.parse(lines, { defaultCurrency: 'CAD' });

      const { order, created } = await persistExtractedOrder(extracted, {
        userId: auth.user.id,
        householdId: auth.household.id,
        source: `${parser.id}-pdf`,
      });

      const matchSummary = auth.household.id != null
        ? await matchReceiptOrderToTransactions({
            externalOrderId: order.id,
            householdId: auth.household.id,
          })
        : { created: 0, updated: 0, tendersProcessed: 0, candidatesScanned: 0 };

      logger.info({
        source: `${parser.id}-pdf`,
        orderId: order.id,
        created,
        vendor: extracted.vendor,
        items: extracted.items.length,
        tenders: extracted.tenders.length,
        warnings: warnings.length,
        linksCreated: matchSummary.created,
        linksUpdated: matchSummary.updated,
        householdId: auth.household.id,
      }, 'external_order_imported');

      res.json({
        order: order.toJSON(),
        created,
        extracted,
        warnings,
        parserId: parser.id,
        match: matchSummary,
      });
    } catch (e) {
      next(e);
    }
  },
);

export default router;
