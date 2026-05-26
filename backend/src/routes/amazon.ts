import { Router } from 'express';
import multer from 'multer';
import { Op, QueryTypes } from 'sequelize';
import {
  ExternalOrder,
  ExternalOrderItem,
  Transaction,
  TransactionOrderLink,
  sequelize,
} from '../models';
import { currentAuth } from '../auth/middleware';
import { visibleTransactionWhere } from '../auth/scope';
import { importAmazonReportCsv } from '../amazon/importAmazonOrders';
import { isAmazonLikeMerchant, runAmazonMatching } from '../amazon/matcher';
import { AMAZON_CATEGORIES, categorizeAmazonItem } from '../amazon/categories';
import {
  applyAmazonItemCategorySuggestions,
  categorizeAmazonItemsWithAi,
} from '../amazon/aiCategorizeAmazonItems';
import { createTrackedSuggestion } from '../ai/suggestionStore';
import { getOpenAiConfig } from '../config/openai';
import { rejectDemoAiRequest } from '../demo/aiAccess';
import { aiSuggestLimiter } from './aiRateLimit';
import { loadCategoryHints } from '../ai/suggestTransaction';
import { scheduleInternalBackfill } from '../import/backfillCoordinator';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (!file.originalname.toLowerCase().endsWith('.csv')) {
      const e = new Error('Only .csv files are allowed') as Error & { status?: number };
      e.status = 400;
      cb(e);
      return;
    }
    cb(null, true);
  },
});

const router = Router();

function orderInclude() {
  return [{ model: ExternalOrderItem, as: 'items' }];
}

async function findScopedOrder(id: number, householdId: number) {
  return ExternalOrder.findOne({
    where: { id, householdId },
    include: orderInclude(),
  });
}

async function loadAmazonCategoryOptions(householdId: number): Promise<string[]> {
  const [householdHints, itemRows] = await Promise.all([
    loadCategoryHints(householdId),
    sequelize.query<{ label: string }>(
      `SELECT DISTINCT TRIM(inferred_category) AS label
       FROM external_order_items i
       INNER JOIN external_orders o ON o.id = i.external_order_id
       WHERE o.household_id = ?
         AND i.inferred_category IS NOT NULL
         AND TRIM(i.inferred_category) != ''`,
      { replacements: [householdId], type: QueryTypes.SELECT },
    ),
  ]);
  const byLower = new Map<string, string>();
  for (const label of [...householdHints, ...itemRows.map((row) => row.label), ...AMAZON_CATEGORIES]) {
    const normalized = String(label || '').trim().replace(/\s+/g, ' ');
    if (normalized) byLower.set(normalized.toLowerCase(), normalized);
  }
  return Array.from(byLower.values()).sort((a, b) => a.localeCompare(b));
}

router.get('/categories', async (req, res, next) => {
  try {
    res.json({ categories: await loadAmazonCategoryOptions(currentAuth(req).household.id) });
  } catch (e) {
    next(e);
  }
});

router.post(
  '/import',
  (req, res, next) => {
    upload.single('file')(req as never, res as never, (err: unknown) => {
      if (err) return next(err);
      next();
    });
  },
  async (req, res, next) => {
    try {
      if (!req.file) {
        res.status(400).json({ error: 'Missing file field "file"' });
        return;
      }
      const { user, household } = currentAuth(req);
      const summary = await importAmazonReportCsv({
        text: req.file.buffer.toString('utf8'),
        householdId: household.id,
        userId: user.id,
      });
      res.json(summary);
    } catch (e) {
      next(e);
    }
  },
);

router.get('/orders', async (req, res, next) => {
  try {
    const { household } = currentAuth(req);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 25));
    const orders = await ExternalOrder.findAll({
      where: { householdId: household.id, vendor: 'amazon' },
      include: orderInclude(),
      order: [
        ['orderDate', 'DESC'],
        ['id', 'DESC'],
      ],
      limit,
    });
    res.json(orders);
  } catch (e) {
    next(e);
  }
});

router.get('/orders/:id', async (req, res, next) => {
  try {
    const order = await findScopedOrder(Number(req.params.id), currentAuth(req).household.id);
    if (!order) {
      res.status(404).json({ error: 'Order not found' });
      return;
    }
    res.json(order);
  } catch (e) {
    next(e);
  }
});

router.patch('/orders/:id/items/:itemId', async (req, res, next) => {
  try {
    const { household } = currentAuth(req);
    const order = await findScopedOrder(Number(req.params.id), household.id);
    if (!order) {
      res.status(404).json({ error: 'Order not found' });
      return;
    }
    const item = await ExternalOrderItem.findOne({
      where: { id: Number(req.params.itemId), externalOrderId: order.id },
    });
    if (!item) {
      res.status(404).json({ error: 'Item not found' });
      return;
    }
    const body = req.body as Record<string, unknown>;
    if (Object.prototype.hasOwnProperty.call(body, 'title')) {
      const title = String(body.title || '').trim();
      if (!title) {
        res.status(400).json({ error: 'title cannot be empty' });
        return;
      }
      item.title = title;
      if (!Object.prototype.hasOwnProperty.call(body, 'inferredCategory')) {
        item.inferredCategory = categorizeAmazonItem(title);
      }
    }
    if (Object.prototype.hasOwnProperty.call(body, 'inferredCategory')) {
      const category = String(body.inferredCategory || '').trim();
      const allowedCategories = await loadAmazonCategoryOptions(household.id);
      if (!allowedCategories.some((label) => label.toLowerCase() === category.toLowerCase())) {
        res.status(400).json({ error: 'Invalid category' });
        return;
      }
      item.inferredCategory =
        allowedCategories.find((label) => label.toLowerCase() === category.toLowerCase()) ??
        category;
    }
    if (Object.prototype.hasOwnProperty.call(body, 'businessUsePercent')) {
      const pct =
        body.businessUsePercent === null || body.businessUsePercent === ''
          ? null
          : Number(body.businessUsePercent);
      if (pct != null && (!Number.isFinite(pct) || pct < 0 || pct > 100)) {
        res.status(400).json({ error: 'businessUsePercent must be 0–100' });
        return;
      }
      item.businessUsePercent = pct == null ? null : String(pct);
    }
    if (Object.prototype.hasOwnProperty.call(body, 'totalPrice')) {
      const amount = body.totalPrice === null || body.totalPrice === '' ? null : Number(body.totalPrice);
      if (amount != null && !Number.isFinite(amount)) {
        res.status(400).json({ error: 'totalPrice must be numeric' });
        return;
      }
      item.totalPrice = amount == null ? null : String(amount);
    }
    await item.save();
    res.json(item);
  } catch (e) {
    next(e);
  }
});

router.post('/match/run', async (req, res, next) => {
  try {
    const { household } = currentAuth(req);
    const result = await runAmazonMatching({ householdId: household.id });
    if (result.matchedDateFrom && result.matchedDateTo) {
      // Mirror the post-capture window so the matched txns get re-enriched
      // and pick up the new item-link signal (vendor canonical, notes, etc.).
      // ±14d matches the bookmarklet path in routes/capture.ts.
      const dateFrom = shiftDate(result.matchedDateFrom, -14);
      const dateTo = shiftDate(result.matchedDateTo, 14);
      scheduleInternalBackfill({
        householdId: household.id,
        dateFrom,
        dateTo,
        source: 'amazon-match',
      });
    }
    res.json(result);
  } catch (e) {
    next(e);
  }
});

function shiftDate(yyyyMmDd: string, days: number): string {
  const d = new Date(`${yyyyMmDd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

router.post('/categorize/run', aiSuggestLimiter, async (req, res, next) => {
  try {
    if (rejectDemoAiRequest(req, res)) return;
    if (!getOpenAiConfig()) {
      res.status(503).json({ error: 'OpenAI is not configured (set OPENAI_API_KEY)' });
      return;
    }
    const body = (req.body || {}) as {
      orderId?: unknown;
      itemIds?: unknown;
      limit?: unknown;
    };
    const orderId =
      body.orderId == null || body.orderId === '' ? null : Number(body.orderId);
    if (orderId != null && (!Number.isFinite(orderId) || orderId < 1)) {
      res.status(400).json({ error: 'orderId must be a positive integer' });
      return;
    }
    const itemIds = Array.isArray(body.itemIds)
      ? body.itemIds
          .map((value) => Number(value))
          .filter((value) => Number.isFinite(value) && value > 0)
      : undefined;
    const limit =
      body.limit == null || body.limit === ''
        ? undefined
        : Math.min(100, Math.max(1, Number(body.limit)));
    const { household } = currentAuth(req);
    const result = await categorizeAmazonItemsWithAi({
      householdId: household.id,
      orderId,
      itemIds,
      limit,
    });
    const updated = await applyAmazonItemCategorySuggestions(result.suggestions);
    const audit = await createTrackedSuggestion({
      req,
      kind: 'amazon_item_categories',
      inputSnapshot: result.inputSnapshot,
      output: { items: result.suggestions },
      model: result.meta.model,
      promptVersion: result.promptVersion,
      temperature: result.meta.temperature,
      latencyMs: result.meta.latencyMs,
      providerRequestId: result.meta.providerRequestId,
    });
    res.json({
      categorizationId: audit.id,
      updated,
      suggestions: result.suggestions,
    });
  } catch (e) {
    next(e);
  }
});

router.get('/review-transactions', async (req, res, next) => {
  try {
    const txns = await Transaction.findAll({
      where: {
        ...visibleTransactionWhere(req),
        [Op.or]: [
          { merchantRaw: { [Op.like]: '%AMAZON%' } },
          { merchantRaw: { [Op.like]: '%Amazon%' } },
          { merchantRaw: { [Op.like]: '%AMZN%' } },
          { merchantRaw: { [Op.like]: '%Prime%' } },
          { merchantClean: { [Op.like]: '%AMAZON%' } },
          { merchantClean: { [Op.like]: '%Amazon%' } },
          { merchantClean: { [Op.like]: '%AMZN%' } },
          { merchantClean: { [Op.like]: '%Prime%' } },
        ],
      },
      include: [
        {
          model: TransactionOrderLink,
          as: 'orderLinks',
          required: false,
          include: [{ model: ExternalOrder, as: 'order', include: orderInclude() }],
        },
      ],
      order: [['date', 'DESC']],
      limit: 100,
    });
    res.json(
      txns.filter((txn) => isAmazonLikeMerchant(`${txn.merchantRaw} ${txn.merchantClean}`)),
    );
  } catch (e) {
    next(e);
  }
});

router.post('/links/:id/accept', async (req, res, next) => {
  try {
    const link = await TransactionOrderLink.findByPk(Number(req.params.id), {
      include: [{ model: Transaction, as: 'transaction' }],
    });
    const txn = link?.get('transaction') as Transaction | undefined;
    if (!link || !txn || txn.householdId !== currentAuth(req).household.id) {
      res.status(404).json({ error: 'Link not found' });
      return;
    }
    await link.update({ status: 'accepted' });
    res.json(link);
  } catch (e) {
    next(e);
  }
});

router.post('/links/:id/reject', async (req, res, next) => {
  try {
    const link = await TransactionOrderLink.findByPk(Number(req.params.id), {
      include: [{ model: Transaction, as: 'transaction' }],
    });
    const txn = link?.get('transaction') as Transaction | undefined;
    if (!link || !txn || txn.householdId !== currentAuth(req).household.id) {
      res.status(404).json({ error: 'Link not found' });
      return;
    }
    await link.update({ status: 'rejected' });
    res.json(link);
  } catch (e) {
    next(e);
  }
});

router.post('/links/manual', async (req, res, next) => {
  try {
    const body = req.body as { transactionId?: unknown; externalOrderId?: unknown };
    const transactionId = Number(body.transactionId);
    const externalOrderId = Number(body.externalOrderId);
    const { household } = currentAuth(req);
    const [txn, order] = await Promise.all([
      Transaction.findOne({ where: { id: transactionId, ...visibleTransactionWhere(req) } }),
      ExternalOrder.findOne({ where: { id: externalOrderId, householdId: household.id } }),
    ]);
    if (!txn || !order) {
      res.status(404).json({ error: 'Transaction or order not found' });
      return;
    }
    const [link] = await TransactionOrderLink.findOrCreate({
      where: { transactionId, externalOrderId },
      defaults: {
        transactionId,
        externalOrderId,
        confidence: '100',
        matchReason: 'manually linked by user',
        status: 'accepted',
      },
    });
    if (link.status !== 'accepted') {
      await link.update({ status: 'accepted', confidence: '100', matchReason: 'manually linked by user' });
    }
    res.status(201).json(link);
  } catch (e) {
    next(e);
  }
});

router.delete('/links/:id', async (req, res, next) => {
  try {
    const link = await TransactionOrderLink.findByPk(Number(req.params.id), {
      include: [{ model: Transaction, as: 'transaction' }],
    });
    const txn = link?.get('transaction') as Transaction | undefined;
    if (!link || !txn || txn.householdId !== currentAuth(req).household.id) {
      res.status(404).json({ error: 'Link not found' });
      return;
    }
    await link.destroy();
    res.status(204).send();
  } catch (e) {
    next(e);
  }
});

export default router;
