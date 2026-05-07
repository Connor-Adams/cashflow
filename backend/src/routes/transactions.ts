import { Router } from 'express';
import { Op, QueryTypes } from 'sequelize';
import { Transaction, Account, Contact, sequelize } from '../models';
import { recomputeTransactionAmounts } from '../import/calculateShares';
import { serializeTransaction } from '../util/serializeTransaction';
import {
  loadCategoryHints,
  suggestTransactionFields,
} from '../ai/suggestTransaction';
import { aiSuggestLimiter } from './aiRateLimit';
import { getOpenAiConfig } from '../config/openai';
import { currentAuth } from '../auth/middleware';
import { isSuperadmin, visibleTransactionWhere } from '../auth/scope';
import { rejectDemoAiRequest } from '../demo/aiAccess';
import { logger } from '../observability/logger';

const router = Router();

function logTransactionEvent(
  event: string,
  details: Record<string, string | number | boolean | null | undefined>
): void {
  logger.info(`transactions_${event}`, details);
}

const PATCHABLE_KEYS = [
  'categoryOverride',
  'businessOverride',
  'splitOverride',
  'pctMeOverride',
  'pctPartnerOverride',
  'notes',
  'visibility',
  'ownershipType',
  'ownershipContactId',
] as const;

async function applyPatchBody(
  req: import('express').Request,
  txn: InstanceType<typeof Transaction>,
  b: Record<string, unknown>
): Promise<void> {
  const { household } = currentAuth(req);
  for (const k of PATCHABLE_KEYS) {
    if (Object.prototype.hasOwnProperty.call(b, k)) {
      if (k === 'visibility') {
        txn.set('visibility', b[k] === 'shared' ? 'shared' : 'private');
      } else if (k === 'ownershipType') {
        const val = String(b[k]);
        if (!['me', 'partner', 'shared', 'contact'].includes(val)) {
          const err = new Error('Invalid ownershipType') as Error & { status?: number };
          err.status = 400;
          throw err;
        }
        txn.set('ownershipType', val);
      } else if (k === 'ownershipContactId') {
        if (b[k] == null || b[k] === '') {
          txn.set('ownershipContactId', null);
        } else {
          const contactId = Number(b[k]);
          const contact = await Contact.findOne({
            where: { id: contactId, householdId: household.id },
          });
          if (!contact) {
            const err = new Error('ownershipContactId must reference a household contact') as Error & { status?: number };
            err.status = 400;
            throw err;
          }
          txn.set('ownershipContactId', contact.id);
        }
      } else {
        txn.set(k, b[k] as never);
      }
    }
  }
  if (txn.get('ownershipType') !== 'contact') txn.set('ownershipContactId', null);
  if (txn.get('ownershipType') === 'contact' && !txn.get('ownershipContactId')) {
    const err = new Error('ownershipContactId is required for contact ownership') as Error & { status?: number };
    err.status = 400;
    throw err;
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
    if (rejectDemoAiRequest(req, res)) return;
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
    const hints = await loadCategoryHints(
      isSuperadmin(req) ? null : currentAuth(req).household.id
    );
    const results: {
      id: number;
      suggestion: Awaited<ReturnType<typeof suggestTransactionFields>>;
    }[] = [];
    for (const id of ids) {
        const txn = await Transaction.findOne({ where: { id, ...visibleTransactionWhere(req) } });
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
    logTransactionEvent('bulk_patch_started', {
      count: ids.length,
      idsPreview: ids.slice(0, 10).join(','),
      patchKeys: Object.keys(patch).join(','),
    });

    await sequelize.transaction(async (t) => {
      for (const id of ids) {
        const txn = await Transaction.findOne({
          where: { id, ...visibleTransactionWhere(req) },
          transaction: t,
        });
        if (!txn) {
          const err = new Error(`Transaction ${id} not found`) as Error & {
            status?: number;
          };
          err.status = 404;
          throw err;
        }
        await applyPatchBody(req, txn, patch);
        recomputeTransactionAmounts(txn);
        await txn.save({ transaction: t });
      }
    });

    logTransactionEvent('bulk_patch_completed', {
      count: ids.length,
    });
    res.json({ updated: ids.length });
  } catch (e) {
    next(e);
  }
});

router.get('/category-hints', async (_req, res, next) => {
  try {
    const householdId = isSuperadmin(_req) ? null : currentAuth(_req).household.id;
    const ruleWhere =
      householdId == null
        ? `category IS NOT NULL AND TRIM(category) != ''`
        : `household_id = ? AND category IS NOT NULL AND TRIM(category) != ''`;
    const txnWhere =
      householdId == null
        ? `final_category IS NOT NULL AND TRIM(final_category) != ''`
        : `household_id = ? AND final_category IS NOT NULL AND TRIM(final_category) != ''`;
    const replacements = householdId == null ? [] : [householdId];
    const [ruleRows, txnRows] = await Promise.all([
      sequelize.query<{ label: string }>(
        `SELECT DISTINCT TRIM(category) AS label
         FROM rules
         WHERE ${ruleWhere}`,
        { replacements, type: QueryTypes.SELECT },
      ),
      sequelize.query<{ label: string; usageCount: string }>(
        `SELECT TRIM(final_category) AS label, COUNT(*) AS usageCount
         FROM transactions
         WHERE ${txnWhere}
         GROUP BY TRIM(final_category)`,
        { replacements, type: QueryTypes.SELECT },
      ),
    ]);

    const byLabel = new Map<string, { label: string; usageCount: number }>();
    for (const row of ruleRows) {
      if (!row.label) continue;
      byLabel.set(row.label, { label: row.label, usageCount: 0 });
    }
    for (const row of txnRows) {
      if (!row.label) continue;
      byLabel.set(row.label, {
        label: row.label,
        usageCount: parseInt(String(row.usageCount), 10) || 0,
      });
    }

    res.json({
      categories: Array.from(byLabel.values()).sort((a, b) =>
        b.usageCount === a.usageCount
          ? a.label.localeCompare(b.label)
          : b.usageCount - a.usageCount
      ),
    });
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

    const where: Record<string, unknown> = { ...visibleTransactionWhere(req) };
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
    if (rejectDemoAiRequest(req, res)) return;
    if (!getOpenAiConfig()) {
      res.status(503).json({ error: 'OpenAI is not configured (set OPENAI_API_KEY)' });
      return;
    }
    const id = parseInt(String(req.params.id), 10);
    if (Number.isNaN(id) || id < 1) {
      res.status(400).json({ error: 'Invalid id' });
      return;
    }
    const txn = await Transaction.findOne({ where: { id, ...visibleTransactionWhere(req) } });
    if (!txn) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    const hints = await loadCategoryHints(
      isSuperadmin(req) ? null : currentAuth(req).household.id
    );
    const suggestion = await suggestTransactionFields(txn, hints);
    res.json({ suggestion });
  } catch (e) {
    next(e);
  }
});

router.patch('/:id', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    const b = (req.body || {}) as Record<string, unknown>;
    logTransactionEvent('patch_started', {
      id,
      patchKeys: Object.keys(b).join(','),
    });
    const txn = await Transaction.findOne({ where: { id, ...visibleTransactionWhere(req) } });
    if (!txn) {
      res.status(404).json({ error: 'Not found' });
      return;
    }

    await applyPatchBody(req, txn, b);

    recomputeTransactionAmounts(txn);
    await txn.save();
    await txn.reload({
      include: [{ model: Account, as: 'account', attributes: ['id', 'name', 'shortCode'] }],
    });
    logTransactionEvent('patch_completed', { id });
    res.json(serializeTransaction(txn));
  } catch (e) {
    next(e);
  }
});

export default router;
