import { Router } from 'express';
import { Op, QueryTypes } from 'sequelize';
import { Transaction, Account, Contact, sequelize } from '../models';
import { recomputeTransactionAmounts } from '../import/calculateShares';
import { serializeTransaction } from '../util/serializeTransaction';
import {
  loadCategoryHints,
  suggestTransactionFields,
  suggestTransactionFieldsTracked,
} from '../ai/suggestTransaction';
import { createTrackedSuggestion, markTransactionSuggestionOutcome } from '../ai/suggestionStore';
import { aiSuggestLimiter } from './aiRateLimit';
import { getOpenAiConfig } from '../config/openai';
import { currentAuth } from '../auth/middleware';
import { isSuperadmin, visibleTransactionWhere } from '../auth/scope';
import { rejectDemoAiRequest } from '../demo/aiAccess';
import { logger } from '../observability/logger';

const router = Router();

/**
 * Maximum number of transactions the filter-mode bulk patch endpoint will
 * touch in a single call. The frontend uses this to warn the user before
 * submitting; the server enforces it authoritatively with a 422.
 */
export const BULK_PATCH_FILTER_MAX = 1000;

/**
 * Pure helper used to enforce {@link BULK_PATCH_FILTER_MAX}. Extracted from
 * the route handler so it can be unit-tested without a database.
 * Returns `null` when the count is within range, or a payload describing the
 * overage so the route can respond with 422.
 */
export function enforceBulkPatchCap(
  matchedCount: number,
  max: number = BULK_PATCH_FILTER_MAX
): { error: string; matched: number; max: number } | null {
  if (!Number.isFinite(matchedCount) || matchedCount < 0) {
    return { error: 'matched count must be a non-negative number', matched: 0, max };
  }
  if (matchedCount > max) {
    return {
      error: `Filter matches ${matchedCount} transactions; the cap per operation is ${max}. Narrow your filters and try again.`,
      matched: matchedCount,
      max,
    };
  }
  return null;
}

/**
 * Build the Sequelize `where` clause for transaction listings/filtered bulk
 * operations. Reads the same fields the GET handler reads from the request
 * (query params for GET, body.filter for filtered bulk patch). Keeping this
 * in one place ensures the bulk-patch-filter endpoint operates on exactly
 * the same set the user sees in the table.
 */
function buildTransactionFilterWhere(
  req: import('express').Request,
  source: Record<string, unknown>
): Record<string, unknown> {
  const where: Record<string, unknown> = { ...visibleTransactionWhere(req) };
  if (source.accountId) {
    where.accountId = parseInt(String(source.accountId), 10);
  }
  if (source.reviewFlag === 'true' || source.reviewFlag === true) where.reviewFlag = true;
  if (source.reviewFlag === 'false' || source.reviewFlag === false) where.reviewFlag = false;
  if (source.currency) {
    where.currency = String(source.currency).toUpperCase().slice(0, 3);
  }
  if (source.category) {
    where.finalCategory = String(source.category);
  }
  if (source.importBatch) {
    where.importBatch = String(source.importBatch);
  }
  if (source.dateFrom || source.dateTo) {
    const dateCond: { [Op.gte]?: string; [Op.lte]?: string } = {};
    if (source.dateFrom) dateCond[Op.gte] = String(source.dateFrom);
    if (source.dateTo) dateCond[Op.lte] = String(source.dateTo);
    where.date = dateCond;
  }
  return where;
}

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
      suggestionId: number;
      suggestion: Awaited<ReturnType<typeof suggestTransactionFields>>;
    }[] = [];
    for (const id of ids) {
        const txn = await Transaction.findOne({ where: { id, ...visibleTransactionWhere(req) } });
      if (!txn) {
        res.status(404).json({ error: `Transaction ${id} not found` });
        return;
      }
      const tracked = await suggestTransactionFieldsTracked(txn, hints);
      const row = await createTrackedSuggestion({
        req,
        transactionId: txn.id,
        kind: 'transaction_fields',
        inputSnapshot: tracked.inputSnapshot,
        output: tracked.suggestion,
        model: tracked.meta.model,
        promptVersion: tracked.promptVersion,
        temperature: tracked.meta.temperature,
        latencyMs: tracked.meta.latencyMs,
        providerRequestId: tracked.meta.providerRequestId,
      });
      results.push({ id, suggestionId: row.id, suggestion: tracked.suggestion });
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

router.post('/bulk-patch-filter', async (req, res, next) => {
  try {
    const body = (req.body || {}) as { filter?: unknown; patch?: unknown };
    const filter =
      body.filter && typeof body.filter === 'object' && body.filter !== null
        ? (body.filter as Record<string, unknown>)
        : {};
    const patch =
      body.patch && typeof body.patch === 'object' && body.patch !== null
        ? (body.patch as Record<string, unknown>)
        : {};
    if (Object.keys(patch).length === 0) {
      res.status(400).json({ error: 'patch must include at least one field' });
      return;
    }

    const where = buildTransactionFilterWhere(req, filter);
    const matchedCount = await Transaction.count({ where });
    const overage = enforceBulkPatchCap(matchedCount);
    if (overage) {
      logTransactionEvent('bulk_patch_filter_capped', {
        matched: overage.matched,
        max: overage.max,
        filterKeys: Object.keys(filter).join(','),
      });
      res
        .status(422)
        .json({ error: overage.error, matched: overage.matched, max: overage.max });
      return;
    }

    logTransactionEvent('bulk_patch_filter_started', {
      matched: matchedCount,
      filterKeys: Object.keys(filter).join(','),
      patchKeys: Object.keys(patch).join(','),
    });

    const updatedIds: number[] = [];
    await sequelize.transaction(async (t) => {
      // Pull every matching row up front to keep the patched set deterministic
      // for the duration of the transaction. The count above also gates this
      // against runaway memory use via {@link BULK_PATCH_FILTER_MAX}.
      const matched = await Transaction.findAll({
        where,
        transaction: t,
        order: [
          ['date', 'DESC'],
          ['id', 'DESC'],
        ],
      });
      for (const txn of matched) {
        await applyPatchBody(req, txn, patch);
        recomputeTransactionAmounts(txn);
        await txn.save({ transaction: t });
        updatedIds.push(txn.id);
      }
    });

    logTransactionEvent('bulk_patch_filter_completed', {
      updated: updatedIds.length,
    });
    res.json({ updated: updatedIds.length, ids: updatedIds });
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

    const where = buildTransactionFilterWhere(
      req,
      req.query as Record<string, unknown>
    );

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
    let receiptWarningMap: Record<number, string[]> = {};
    if (txnIds.length > 0) {
      const placeholders = txnIds.map(() => '?').join(',');
      const receiptRows = await sequelize.query<{
        transactionId: number;
        extractedNote: string | null;
      }>(
        `SELECT transaction_id AS transactionId, extracted_note AS extractedNote
         FROM receipts
         WHERE transaction_id IN (${placeholders})
           AND extracted_note IS NOT NULL
         ORDER BY created_at DESC`,
        { replacements: txnIds, type: QueryTypes.SELECT },
      );
      const txnById = new Map(rows.map((row) => [row.id, row]));
      receiptWarningMap = {};
      for (const row of receiptRows) {
        if (receiptWarningMap[row.transactionId]) continue;
        const txn = txnById.get(row.transactionId);
        if (!txn || !row.extractedNote) continue;
        try {
          const extracted = JSON.parse(row.extractedNote) as {
            total?: unknown;
            currency?: unknown;
            date?: unknown;
          };
          const warnings: string[] = [];
          const receiptTotal = Number(extracted.total);
          const txnAmountAbs = Math.abs(Number(txn.amount));
          if (
            Number.isFinite(receiptTotal) &&
            Number.isFinite(txnAmountAbs) &&
            Math.abs(receiptTotal - txnAmountAbs) > 0.02
          ) {
            warnings.push('receipt total differs');
          }
          if (
            typeof extracted.currency === 'string' &&
            extracted.currency.toUpperCase() !== txn.currency
          ) {
            warnings.push('receipt currency differs');
          }
          if (typeof extracted.date === 'string' && extracted.date !== txn.date) {
            warnings.push('receipt date differs');
          }
          if (warnings.length) receiptWarningMap[row.transactionId] = warnings;
        } catch {
          receiptWarningMap[row.transactionId] = ['receipt extract could not be read'];
        }
      }
    }

    res.json({
      data: rows.map((row) => ({
        ...serializeTransaction(row),
        receiptCount: receiptCountMap[row.id] ?? 0,
        receiptWarnings: receiptWarningMap[row.id] ?? [],
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
    const tracked = await suggestTransactionFieldsTracked(txn, hints);
    const row = await createTrackedSuggestion({
      req,
      transactionId: txn.id,
      kind: 'transaction_fields',
      inputSnapshot: tracked.inputSnapshot,
      output: tracked.suggestion,
      model: tracked.meta.model,
      promptVersion: tracked.promptVersion,
      temperature: tracked.meta.temperature,
      latencyMs: tracked.meta.latencyMs,
      providerRequestId: tracked.meta.providerRequestId,
    });
    res.json({ suggestion: tracked.suggestion, suggestionId: row.id });
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
    const aiSuggestionId = Number(b.aiSuggestionId);
    if (Number.isInteger(aiSuggestionId) && aiSuggestionId > 0) {
      await markTransactionSuggestionOutcome(req, aiSuggestionId, txn);
    }
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
