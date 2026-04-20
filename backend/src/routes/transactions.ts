import { Router } from 'express';
import { Op, QueryTypes } from 'sequelize';
import { Transaction, Account, sequelize } from '../models';
import { recomputeTransactionAmounts } from '../import/calculateShares';
import { serializeTransaction } from '../util/serializeTransaction';
import {
  loadCategoryHints,
  suggestTransactionFields,
} from '../ai/suggestTransaction';
import { aiSuggestLimiter } from './aiRateLimit';
import { getOpenAiConfig } from '../config/openai';

const router = Router();

const PATCHABLE_KEYS = [
  'categoryOverride',
  'businessOverride',
  'splitOverride',
  'pctMeOverride',
  'pctPartnerOverride',
  'notes',
] as const;

function applyPatchBody(
  txn: InstanceType<typeof Transaction>,
  b: Record<string, unknown>
): void {
  for (const k of PATCHABLE_KEYS) {
    if (Object.prototype.hasOwnProperty.call(b, k)) {
      txn.set(k, b[k] as never);
    }
  }
  if (Object.prototype.hasOwnProperty.call(b, 'reviewFlag')) {
    txn.set('reviewFlag', Boolean(b.reviewFlag));
    if (b.reviewFlag === false) {
      txn.set('reviewedAt', new Date());
    }
  }
}

router.post('/bulk-ai-suggest', aiSuggestLimiter, async (req, res, next) => {
  try {
    if (!getOpenAiConfig()) {
      res.status(503).json({ error: 'OpenAI is not configured (set OPENAI_API_KEY)' });
      return;
    }
    const body = (req.body || {}) as { ids?: unknown };
    if (!Array.isArray(body.ids) || body.ids.length === 0) {
      res.status(400).json({ error: 'ids must be a non-empty array' });
      return;
    }
    if (body.ids.length > 15) {
      res.status(400).json({ error: 'At most 15 ids per AI request' });
      return;
    }
    const ids: number[] = [];
    for (const raw of body.ids) {
      const id = parseInt(String(raw), 10);
      if (Number.isNaN(id) || id < 1) {
        res.status(400).json({ error: 'Each id must be a positive integer' });
        return;
      }
      ids.push(id);
    }
    const hints = await loadCategoryHints();
    const results: {
      id: number;
      suggestion: Awaited<ReturnType<typeof suggestTransactionFields>>;
    }[] = [];
    for (const id of ids) {
      const txn = await Transaction.findByPk(id);
      if (!txn) {
        res.status(404).json({ error: `Transaction ${id} not found` });
        return;
      }
      const suggestion = await suggestTransactionFields(txn, hints);
      results.push({ id, suggestion });
    }
    res.json({ results });
  } catch (e) {
    next(e);
  }
});

router.post('/bulk-patch', async (req, res, next) => {
  try {
    const body = (req.body || {}) as { ids?: unknown; patch?: unknown };
    if (!Array.isArray(body.ids) || body.ids.length === 0) {
      res.status(400).json({ error: 'ids must be a non-empty array' });
      return;
    }
    if (body.ids.length > 200) {
      res.status(400).json({ error: 'At most 200 ids per request' });
      return;
    }
    const ids: number[] = [];
    for (const raw of body.ids) {
      const id = parseInt(String(raw), 10);
      if (Number.isNaN(id) || id < 1) {
        res.status(400).json({ error: 'Each id must be a positive integer' });
        return;
      }
      ids.push(id);
    }
    const patch =
      body.patch && typeof body.patch === 'object' && body.patch !== null
        ? (body.patch as Record<string, unknown>)
        : {};
    if (Object.keys(patch).length === 0) {
      res.status(400).json({ error: 'patch must include at least one field' });
      return;
    }

    await sequelize.transaction(async (t) => {
      for (const id of ids) {
        const txn = await Transaction.findByPk(id, { transaction: t });
        if (!txn) {
          const err = new Error(`Transaction ${id} not found`) as Error & {
            status?: number;
          };
          err.status = 404;
          throw err;
        }
        applyPatchBody(txn, patch);
        recomputeTransactionAmounts(txn);
        await txn.save({ transaction: t });
      }
    });

    res.json({ updated: ids.length });
  } catch (e) {
    next(e);
  }
});

router.get('/', async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(String(req.query.page || '1'), 10));
    const pageSize = Math.min(
      100,
      Math.max(1, parseInt(String(req.query.pageSize || '25'), 10))
    );
    const offset = (page - 1) * pageSize;

    const where: Record<string, unknown> = {};
    if (req.query.accountId) {
      where.accountId = parseInt(String(req.query.accountId), 10);
    }
    if (req.query.reviewFlag === 'true') where.reviewFlag = true;
    if (req.query.reviewFlag === 'false') where.reviewFlag = false;
    if (req.query.currency) {
      where.currency = String(req.query.currency).toUpperCase().slice(0, 3);
    }
    if (req.query.category) {
      where.finalCategory = String(req.query.category);
    }
    if (req.query.importBatch) {
      where.importBatch = String(req.query.importBatch);
    }
    if (req.query.dateFrom || req.query.dateTo) {
      const dateCond: { [Op.gte]?: string; [Op.lte]?: string } = {};
      if (req.query.dateFrom) dateCond[Op.gte] = String(req.query.dateFrom);
      if (req.query.dateTo) dateCond[Op.lte] = String(req.query.dateTo);
      where.date = dateCond;
    }

    const { rows, count } = await Transaction.findAndCountAll({
      where,
      include: [{ model: Account, as: 'account', attributes: ['id', 'name', 'shortCode'] }],
      order: [
        ['date', 'DESC'],
        ['id', 'DESC'],
      ],
      limit: pageSize,
      offset,
    });

    const txnIds = rows.map((r) => r.id);
    let receiptCountMap: Record<number, number> = {};
    if (txnIds.length > 0) {
      const placeholders = txnIds.map(() => '?').join(',');
      const cntRows = await sequelize.query<{ transactionId: number; cnt: string }>(
        `SELECT transaction_id AS transactionId, COUNT(*) AS cnt FROM receipts WHERE transaction_id IN (${placeholders}) GROUP BY transaction_id`,
        { replacements: txnIds, type: QueryTypes.SELECT },
      );
      receiptCountMap = Object.fromEntries(
        cntRows.map((r) => [r.transactionId, parseInt(String(r.cnt), 10) || 0]),
      );
    }

    res.json({
      data: rows.map((row) => ({
        ...serializeTransaction(row),
        receiptCount: receiptCountMap[row.id] ?? 0,
      })),
      page,
      pageSize,
      total: count,
    });
  } catch (e) {
    next(e);
  }
});

router.post('/:id/ai-suggest', aiSuggestLimiter, async (req, res, next) => {
  try {
    if (!getOpenAiConfig()) {
      res.status(503).json({ error: 'OpenAI is not configured (set OPENAI_API_KEY)' });
      return;
    }
    const id = parseInt(String(req.params.id), 10);
    if (Number.isNaN(id) || id < 1) {
      res.status(400).json({ error: 'Invalid id' });
      return;
    }
    const txn = await Transaction.findByPk(id);
    if (!txn) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    const hints = await loadCategoryHints();
    const suggestion = await suggestTransactionFields(txn, hints);
    res.json({ suggestion });
  } catch (e) {
    next(e);
  }
});

router.patch('/:id', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    const txn = await Transaction.findByPk(id);
    if (!txn) {
      res.status(404).json({ error: 'Not found' });
      return;
    }

    const b = (req.body || {}) as Record<string, unknown>;
    applyPatchBody(txn, b);

    recomputeTransactionAmounts(txn);
    await txn.save();
    await txn.reload({
      include: [{ model: Account, as: 'account', attributes: ['id', 'name', 'shortCode'] }],
    });
    res.json(serializeTransaction(txn));
  } catch (e) {
    next(e);
  }
});

export default router;
