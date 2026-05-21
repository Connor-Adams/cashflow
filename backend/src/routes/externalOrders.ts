import { Router } from 'express';
import multer from 'multer';
import { sequelize, ExternalOrder, ExternalOrderItem } from '../models';
import { currentAuth } from '../auth/middleware';
import { logger } from '../observability/logger';
import {
  extractReceiptFromImage,
  extractReceiptFromText,
  type ExtractedReceiptOrder,
} from '../ai/extractReceiptItems';
import { aiSuggestLimiter } from './aiRateLimit';
import { rejectDemoAiRequest } from '../demo/aiAccess';

const router = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
});

async function persistExtractedOrder(
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
        subtotal: null,
        tax: null,
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
    return { order, created };
  });
}

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

    logger.info('external_order_imported', {
      source: 'email-paste',
      orderId: order.id,
      created,
      vendor: extracted.vendor,
      items: extracted.items.length,
      householdId: auth.household.id,
    });

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
  (req, res, next) => {
    upload.single('file')(req as never, res as never, (err: unknown) => {
      if (err) return next(err);
      next();
    });
  },
  async (req, res, next) => {
    try {
      if (rejectDemoAiRequest(req, res)) return;
      const auth = currentAuth(req);
      const file = (req as unknown as { file?: { mimetype: string; buffer: Buffer } }).file;
      if (!file) {
        res.status(400).json({ error: 'file is required' });
        return;
      }
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
      logger.info('external_order_imported', {
        source: 'image-upload',
        orderId: order.id,
        created,
        vendor: extracted.vendor,
        items: extracted.items.length,
        householdId: auth.household.id,
      });
      res.json({ order: order.toJSON(), created, extracted });
    } catch (e) {
      next(e);
    }
  },
);

export default router;
