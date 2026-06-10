import { Router } from 'express';
import { Op, QueryTypes } from 'sequelize';
import {
  Transaction,
  Account,
  Contact,
  TransactionRevision,
  Label,
  TransactionLabel,
  AiSuggestion,
  ProviderJobLog,
  sequelize,
} from '../models';
import { recomputeTransactionAmounts } from '../import/calculateShares';
import { serializeTransaction } from '../util/serializeTransaction';
import { enrichmentItemClearConfidence } from '../config/env';
import { computeReceiptWarnings } from '../util/receiptWarnings';
import {
  loadCategoryHints,
  suggestTransactionFields,
  suggestTransactionFieldsTracked,
} from '../ai/suggestTransaction';
import { createTrackedSuggestion, markTransactionSuggestionOutcome } from '../ai/suggestionStore';
import {
  COUNTERPARTY_PROMOTION_WINDOW_DAYS,
  normalizeCounterpartyName,
} from '../ai/counterpartyPromotions';
import { aiSuggestLimiter } from './aiRateLimit';
import { getOpenAiConfig } from '../config/openai';
import {
  AUDIT_ACTIONS,
  AUDIT_ENTITY_TYPES,
  diffPatchableFields,
  recordAudit,
} from '../audit/log';
import {
  FINANCE_EVENT_TYPES,
  FINANCE_EVENT_ENTITY_TYPES,
  recordFinanceEvent,
} from '../events/financeEvents';
import { currentAuth } from '../auth/middleware';
import { householdWhere, isSuperadmin, visibleTransactionWhere } from '../auth/scope';
import { rejectDemoAiRequest } from '../demo/aiAccess';
import { logger } from '../observability/logger';
import { runBackfill } from '../import/runEnrichmentBackfill';
import {
  backfillRunning,
  isBackfillInFlight,
  scheduleInternalBackfill,
} from '../import/backfillCoordinator';
import {
  CounterpartyBackfillInFlightError,
  getLastCounterpartyBackfillRun,
  isCounterpartyBackfillRunning,
  runCounterpartyBackfill,
} from '../import/counterpartyBackfill';
import {
  isInteracSyncRunning,
  runInteracCounterpartySync,
  INTERAC_SYNC_PROVIDER,
} from '../integrations/interacCounterparty';
import {
  parseRevisionChanges,
  RESTORABLE_FIELDS,
  withRevisionContext,
  type RevisionedField,
} from '../util/transactionRevisions';
import { isTransactionStatus } from '../transactions/types';
import { streamCsvExport } from '../services/transactionsExport';
import { findOrCreateContactByName } from '../contacts/findOrCreateContact';
import { isTaxTreatment } from '@cashflow/shared';

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
 * Validates a `dateFrom` / `dateTo` query param. Empty/missing means "no
 * filter" (returns true). Otherwise the value must look like an ISO date
 * (YYYY-MM-DD) or be parseable by `new Date(...)` to a non-NaN timestamp.
 * Without this gate, junk like `?dateFrom=null` reaches Postgres and
 * triggers `invalid input syntax for type date` → 500.
 */
export function isValidDateFilter(raw: unknown): boolean {
  if (raw === undefined || raw === null || raw === '') return true;
  const s = String(raw);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return true;
  return !Number.isNaN(new Date(s).getTime());
}

/**
 * Build the Sequelize `where` clause for transaction listings/filtered bulk
 * operations. Reads the same fields the GET handler reads from the request
 * (query params for GET, body.filter for filtered bulk patch). Keeping this
 * in one place ensures the bulk-patch-filter endpoint operates on exactly
 * the same set the user sees in the table.
 */
export function buildTransactionFilterWhere(
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
  if (isTransactionStatus(source.status)) {
    where.status = source.status;
  }
  if (source.dateFrom || source.dateTo) {
    const dateCond: { [Op.gte]?: string; [Op.lte]?: string } = {};
    if (source.dateFrom) dateCond[Op.gte] = String(source.dateFrom);
    if (source.dateTo) dateCond[Op.lte] = String(source.dateTo);
    where.date = dateCond;
  }
  if (typeof source.ids === 'string' && source.ids.length > 0) {
    const ids = source.ids
      .split(',')
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isInteger(n) && n > 0);
    // -1 matches nothing; auto-increment ids start at 1, so this returns empty when all entries are invalid.
    where.id = ids.length === 0 ? -1 : ids;
  }
  if (source.importConfidence) {
    const v = String(source.importConfidence);
    if (v === 'clean' || v === 'needs_review') {
      where.importConfidence = v;
    }
  }
  // confidenceFlag uses LIKE on the JSON-encoded TEXT column. The classifier
  // serializes tokens as a JSON array (e.g. ["needs_review","missing_category"])
  // so `'%"missing_category"%'` matches deterministically. This avoids needing
  // a JSONB column + GIN index for what is effectively a small enum filter.
  if (typeof source.confidenceFlag === 'string' && source.confidenceFlag.length > 0) {
    where.importConfidenceFlags = {
      [Op.like]: `%"${source.confidenceFlag.replace(/[^a-z_]/gi, '')}"%`,
    };
  }
  // reimbursable=true|false (issue #216): restrict to transactions that DO /
  // DO NOT have a reimbursement claim, via an id IN / NOT IN subquery. We AND
  // it with any existing `where.id` constraint (e.g. ?ids=) using Op.and so the
  // two id predicates compose instead of one clobbering the other.
  if (source.reimbursable === 'true' || source.reimbursable === 'false') {
    const op = source.reimbursable === 'true' ? 'IN' : 'NOT IN';
    const idClause = sequelize.literal(
      `(SELECT transaction_id FROM reimbursements)`,
    );
    const reimbursableCond = { [op === 'IN' ? Op.in : Op.notIn]: idClause };
    if ('id' in where) {
      const existingId = (where as Record<string | symbol, unknown>).id;
      delete (where as Record<string | symbol, unknown>).id;
      (where as Record<symbol, unknown>)[Op.and] = [
        { id: existingId },
        { id: reimbursableCond },
      ];
    } else {
      (where as Record<string, unknown>).id = reimbursableCond;
    }
  }
  // labels=1,2,3 (issue #270): any-of semantics — match transactions tagged
  // with ANY of the given label ids (AC #7). Implemented with an id IN
  // subquery over transaction_labels, composed with any existing id predicate
  // via Op.and so it stacks with ?ids= / ?reimbursable= rather than clobbering.
  if (typeof source.labels === 'string' && source.labels.length > 0) {
    const labelIds = source.labels
      .split(',')
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isInteger(n) && n > 0);
    if (labelIds.length > 0) {
      const idClause = sequelize.literal(
        `(SELECT transaction_id FROM transaction_labels WHERE label_id IN (${labelIds.join(',')}))`,
      );
      const labelCond = { [Op.in]: idClause };
      if ('id' in where || (where as Record<symbol, unknown>)[Op.and]) {
        const existing = (where as Record<string | symbol, unknown>)[Op.and];
        const existingId = (where as Record<string | symbol, unknown>).id;
        delete (where as Record<string | symbol, unknown>).id;
        const andArr = Array.isArray(existing) ? [...existing] : [];
        if (existingId !== undefined) andArr.push({ id: existingId });
        andArr.push({ id: labelCond });
        (where as Record<symbol, unknown>)[Op.and] = andArr;
      } else {
        (where as Record<string, unknown>).id = labelCond;
      }
    } else {
      // All entries invalid → match nothing, consistent with ?ids= behaviour.
      (where as Record<string, unknown>).id = -1;
    }
  }
  return where;
}

function logTransactionEvent(
  event: string,
  details: Record<string, string | number | boolean | null | undefined>
): void {
  logger.info(details, `transactions_${event}`);
}

type ItemizedSummary = { itemCount: number; stragglerCount: number };

/**
 * Loads per-transaction itemized receipt summaries in a single grouped query.
 * Returns a Map from transactionId → { itemCount, stragglerCount } for every
 * transaction that has at least one ACCEPTED order link. Transactions without
 * an accepted order link are not present in the map (callers should ?? null).
 *
 * An item is considered DONE when:
 *   - categoryOverride is non-null/non-empty, OR
 *   - inferredCategory is non-null/non-empty AND confidence >= threshold
 * Otherwise it is a straggler.
 *
 * confidence is a DECIMAL(5,2) column, so it is compared numerically. We must
 * NOT compare it to '' (Postgres coerces '' -> numeric and throws "invalid input
 * syntax for type numeric"); the IS NOT NULL guard is sufficient.
 */
export async function itemizedSummaries(
  txnIds: number[],
): Promise<Map<number, ItemizedSummary>> {
  if (txnIds.length === 0) return new Map();
  const rows = await sequelize.query<{
    transactionId: number;
    itemCount: number;
    stragglerCount: number;
  }>(
    `SELECT tol.transaction_id AS "transactionId",
            COUNT(i.id) AS "itemCount",
            SUM(CASE WHEN (i.category_override IS NOT NULL AND i.category_override <> '')
                       OR (i.inferred_category IS NOT NULL AND i.inferred_category <> ''
                           AND i.confidence IS NOT NULL
                           AND i.confidence >= :threshold)
                     THEN 0 ELSE 1 END) AS "stragglerCount"
       FROM transaction_order_links tol
       JOIN external_order_items i ON i.external_order_id = tol.external_order_id
      WHERE tol.status = 'accepted' AND tol.transaction_id IN (:ids)
      GROUP BY tol.transaction_id`,
    {
      type: QueryTypes.SELECT,
      replacements: { ids: txnIds, threshold: enrichmentItemClearConfidence },
    },
  );
  const map = new Map<number, ItemizedSummary>();
  for (const r of rows) {
    map.set(Number(r.transactionId), {
      itemCount: Number(r.itemCount),
      stragglerCount: Number(r.stragglerCount),
    });
  }
  return map;
}

/**
 * Loads the labels (issue #270) for a page of transactions in a single query,
 * keyed by transaction id. Each value is the list of `{id, name}` labels
 * applied to that transaction, sorted by name. Returns an empty map when there
 * are no transactions so callers can `?? []` per row.
 */
export async function loadLabelsForTransactions(
  txnIds: number[]
): Promise<Record<number, Array<{ id: number; name: string }>>> {
  if (txnIds.length === 0) return {};
  const rows = (await TransactionLabel.findAll({
    where: { transactionId: { [Op.in]: txnIds } },
    include: [{ model: Label, as: 'label', attributes: ['id', 'name'] }],
    order: [[{ model: Label, as: 'label' }, 'name', 'ASC']],
  })) as Array<TransactionLabel & { label?: { id: number; name: string } }>;
  const map: Record<number, Array<{ id: number; name: string }>> = {};
  for (const row of rows) {
    if (!row.label) continue;
    (map[row.transactionId] ??= []).push({ id: row.label.id, name: row.label.name });
  }
  return map;
}

/**
 * Validates a `labelIds` array from a request body: every entry must be a
 * positive integer AND belong to the caller's household. Returns the unique,
 * household-scoped id set on success, or an error describing the first problem.
 * `findHouseholdLabelIds` does the DB scoping check.
 */
export async function resolveHouseholdLabelIds(
  req: import('express').Request,
  rawIds: unknown
): Promise<{ ok: true; ids: number[] } | { ok: false; error: string }> {
  if (!Array.isArray(rawIds)) {
    return { ok: false, error: 'labelIds must be an array' };
  }
  const ids = Array.from(
    new Set(
      rawIds
        .map((v) => Number(v))
        .filter((n) => Number.isInteger(n) && n > 0)
    )
  );
  if (ids.length !== rawIds.length && rawIds.length > 0 && ids.length === 0) {
    return { ok: false, error: 'labelIds must be positive integers' };
  }
  if (ids.length === 0) return { ok: true, ids: [] };
  const owned = await Label.findAll({
    where: { id: { [Op.in]: ids }, ...householdWhere(req) },
    attributes: ['id'],
  });
  if (owned.length !== ids.length) {
    return { ok: false, error: 'one or more labelIds do not belong to this household' };
  }
  return { ok: true, ids };
}

export interface MemorySnapshot {
  reviewedAt: Date | null;
  finalCategory: string | null;
}

/**
 * Decides whether a patched transaction should trigger a memory-fanout
 * re-enrich. Extracted as a pure function so it can be unit-tested without
 * spinning up the route. Returns the request to schedule, or null when no
 * fanout is needed.
 */
export function decideMemoryFanout(
  prev: MemorySnapshot,
  txn: {
    householdId: number | null;
    reviewedAt: Date | null;
    finalCategory: string | null;
    merchantClean: string | null;
  },
): { householdId: number; merchantPattern: string } | null {
  if (txn.householdId == null) return null;
  if (txn.reviewedAt == null) return null;
  if (txn.finalCategory == null || txn.finalCategory === '') return null;
  if (!txn.merchantClean) return null;
  const wasReviewed = prev.reviewedAt != null;
  const categoryUnchanged = prev.finalCategory === txn.finalCategory;
  if (wasReviewed && categoryUnchanged) return null;
  return { householdId: txn.householdId, merchantPattern: txn.merchantClean };
}

function captureMemorySnapshot(txn: InstanceType<typeof Transaction>): MemorySnapshot {
  return {
    reviewedAt: txn.reviewedAt,
    finalCategory: txn.finalCategory,
  };
}

/**
 * findMerchantMemory queries reviewed transactions with a non-null
 * final_category, grouped by exact merchant_clean. A patch shifts that lookup
 * for sibling merchants when:
 *  - the row transitions from unreviewed → reviewed, OR
 *  - finalCategory changes on an already-reviewed row.
 *
 * In either case, schedule a re-enrich pass scoped to the same merchant so
 * siblings can pick up the new memory.
 */
function scheduleMemoryFanoutIfNeeded(
  prev: MemorySnapshot,
  txn: InstanceType<typeof Transaction>,
): void {
  const req = decideMemoryFanout(prev, txn);
  if (!req) return;
  scheduleInternalBackfill({
    householdId: req.householdId,
    merchantPattern: req.merchantPattern,
    source: 'memory-fanout',
  });
}

const PATCHABLE_KEYS = [
  'categoryOverride',
  'businessOverride',
  'taxTreatmentOverride',
  'splitOverride',
  'pctMeOverride',
  'pctPartnerOverride',
  'notes',
  'visibility',
  'ownershipType',
  'ownershipContactId',
  'counterpartyContactId',
  'status',
] as const;

/**
 * Fields snapshotted for the audit-log diff. Includes every directly-
 * patchable user field plus `reviewFlag` and the computed `finalCategory`
 * so a reviewer can see when a re-enrich changed the resolved category
 * after a manual flag flip.
 */
const AUDIT_DIFF_FIELDS = [
  ...PATCHABLE_KEYS,
  'reviewFlag',
  'finalCategory',
] as const;
type AuditDiffField = (typeof AUDIT_DIFF_FIELDS)[number];

function captureAuditFields(
  txn: InstanceType<typeof Transaction>,
): Record<AuditDiffField, unknown> {
  const out = {} as Record<AuditDiffField, unknown>;
  for (const k of AUDIT_DIFF_FIELDS) {
    out[k] = txn.get(k);
  }
  return out;
}

export async function applyPatchBody(
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
      } else if (k === 'counterpartyContactId') {
        if (b[k] == null || b[k] === '') {
          txn.set('counterpartyContactId', null);
        } else {
          const contactId = Number(b[k]);
          const contact = await Contact.findOne({
            where: { id: contactId, householdId: household.id },
          });
          if (!contact) {
            const err = new Error(
              'counterpartyContactId must reference a household contact',
            ) as Error & { status?: number };
            err.status = 400;
            throw err;
          }
          txn.set('counterpartyContactId', contact.id);
        }
      } else if (k === 'status') {
        if (!isTransactionStatus(b[k])) {
          const err = new Error('INVALID_STATUS') as Error & { status?: number };
          err.status = 400;
          throw err;
        }
        txn.set('status', b[k]);
      } else if (k === 'pctMeOverride' || k === 'pctPartnerOverride') {
        // Fractions (0–1) stored as DECIMAL(5,4): percent-scale values like 50
        // overflow on Postgres but store fine on SQLite, so validate here
        // before the dialects can diverge.
        if (b[k] == null || b[k] === '') {
          txn.set(k, null);
        } else {
          const v = Number(b[k]);
          if (!Number.isFinite(v) || v < 0 || v > 1) {
            const err = new Error(
              `${k} must be a fraction between 0 and 1`,
            ) as Error & { status?: number };
            err.status = 400;
            throw err;
          }
          txn.set(k, v as never);
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

/**
 * Keep a linked transfer pair's tax treatment in sync.
 *
 * The per-leg tax fact builders (buildPersonalFacts / buildCorpFacts /
 * shareholderLoanBalance) read `taxTreatmentOverride` from each leg
 * independently and never follow `linkedTransactionId`. Setting a treatment on
 * only ONE leg of a corp↔personal transfer pair therefore desyncs the pair and
 * yields inconsistent T1/T2. Whenever a patch touches `taxTreatmentOverride` on
 * a row that is one leg of a linked pair, mirror the (already-applied) value —
 * including `null` = cleared — onto the sibling leg, so every transactions
 * write path stays consistent with PATCH /api/transfers/:id/tax-treatment.
 *
 * Mirrors ONLY the tax treatment; review state and every other field are left
 * alone (syncing those is the dedicated transfers endpoint's job). Idempotent:
 * no-ops when the patch doesn't touch the treatment, when the row is unlinked,
 * when the sibling is not visible, or when it already matches. Must run inside
 * the same transaction as the primary save so the pair can never half-commit.
 */
async function syncLinkedLegTaxTreatment(
  req: import('express').Request,
  txn: InstanceType<typeof Transaction>,
  patch: Record<string, unknown>,
  t: import('sequelize').Transaction,
): Promise<void> {
  if (!Object.prototype.hasOwnProperty.call(patch, 'taxTreatmentOverride')) return;
  const siblingId = txn.linkedTransactionId;
  if (siblingId == null) return;
  const sibling = await Transaction.findOne({
    where: { id: siblingId, ...visibleTransactionWhere(req) },
    transaction: t,
  });
  if (!sibling) return;
  const value = txn.get('taxTreatmentOverride');
  if (sibling.get('taxTreatmentOverride') === value) return;
  sibling.set('taxTreatmentOverride', value);
  await sibling.save({ transaction: t });
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

    const fanoutTargets: Array<{ snap: MemorySnapshot; txn: InstanceType<typeof Transaction> }> = [];
    const { user: bulkUser } = currentAuth(req);
    await withRevisionContext(
      { changedByUserId: bulkUser.id, source: 'bulk_patch' },
      () =>
        sequelize.transaction(async (t) => {
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
            const snap = captureMemorySnapshot(txn);
            await applyPatchBody(req, txn, patch);
            recomputeTransactionAmounts(txn);
            await txn.save({ transaction: t });
            await syncLinkedLegTaxTreatment(req, txn, patch, t);
            fanoutTargets.push({ snap, txn });
          }
        }),
    );
    // Fire memory-fanout AFTER the outer commit so we never schedule a
    // re-enrich for a transaction whose patch was rolled back.
    for (const { snap, txn } of fanoutTargets) scheduleMemoryFanoutIfNeeded(snap, txn);

    logTransactionEvent('bulk_patch_completed', {
      count: ids.length,
    });
    if (ids.length > 0) {
      await recordAudit({
        req,
        action: AUDIT_ACTIONS.TransactionBulkUpdated,
        entityType: AUDIT_ENTITY_TYPES.Transaction,
        entityId: null,
        summary: `Bulk-updated ${ids.length} transaction(s): ${Object.keys(patch).slice(0, 3).join(', ')}`,
        after: patch,
        metadata: {
          ids: ids.slice(0, 200),
          count: ids.length,
        },
      });
    }
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
    const fanoutTargets: Array<{ snap: MemorySnapshot; txn: InstanceType<typeof Transaction> }> = [];
    const { user: bulkFilterUser } = currentAuth(req);
    await withRevisionContext(
      { changedByUserId: bulkFilterUser.id, source: 'bulk_patch' },
      () =>
        sequelize.transaction(async (t) => {
          // Pull every matching row up front to keep the patched set
          // deterministic for the duration of the transaction. The count above
          // also gates this against runaway memory use via {@link
          // BULK_PATCH_FILTER_MAX}.
          const matched = await Transaction.findAll({
            where,
            transaction: t,
            order: [
              ['date', 'DESC'],
              ['id', 'DESC'],
            ],
          });
          for (const txn of matched) {
            const snap = captureMemorySnapshot(txn);
            await applyPatchBody(req, txn, patch);
            recomputeTransactionAmounts(txn);
            await txn.save({ transaction: t });
            await syncLinkedLegTaxTreatment(req, txn, patch, t);
            updatedIds.push(txn.id);
            fanoutTargets.push({ snap, txn });
          }
        }),
    );
    for (const { snap, txn } of fanoutTargets) scheduleMemoryFanoutIfNeeded(snap, txn);

    logTransactionEvent('bulk_patch_filter_completed', {
      updated: updatedIds.length,
    });
    if (updatedIds.length > 0) {
      await recordAudit({
        req,
        action: AUDIT_ACTIONS.TransactionBulkFilterUpdated,
        entityType: AUDIT_ENTITY_TYPES.Transaction,
        entityId: null,
        summary: `Filter-updated ${updatedIds.length} transaction(s): ${Object.keys(patch).slice(0, 3).join(', ')}`,
        after: patch,
        metadata: {
          ids: updatedIds.slice(0, 200),
          count: updatedIds.length,
          filterKeys: Object.keys(filter),
        },
      });
    }
    res.json({ updated: updatedIds.length, ids: updatedIds });
  } catch (e) {
    next(e);
  }
});

/**
 * POST /api/transactions/bulk/labels — apply or remove one label across many
 * transactions (issue #270, AC #6). Body: { transactionIds, labelId, op }.
 *
 * - op='apply': idempotently add the label to each transaction. Rows that
 *   already have the (txn,label) pair are skipped (composite PK), so applying
 *   to a partially-labelled set is a no-op for the already-labelled rows and
 *   never errors or duplicates.
 * - op='remove': delete the (txn,label) rows that exist; missing ones are
 *   silently ignored.
 *
 * Registered BEFORE the dynamic `/:id/...` routes so the literal `bulk` path
 * segment is not captured as an `:id`.
 *
 * All transactionIds and the labelId must belong to the caller's household.
 */
router.post('/bulk/labels', async (req, res, next) => {
  try {
    const b = (req.body || {}) as Record<string, unknown>;
    const op = b.op === 'apply' || b.op === 'remove' ? b.op : null;
    if (!op) {
      res.status(400).json({ error: "op must be 'apply' or 'remove'" });
      return;
    }
    const labelId = Number(b.labelId);
    if (!Number.isInteger(labelId) || labelId <= 0) {
      res.status(400).json({ error: 'labelId must be a positive integer' });
      return;
    }
    const labelOwned = await Label.findOne({
      where: { id: labelId, ...householdWhere(req) },
    });
    if (!labelOwned) {
      res.status(404).json({ error: 'Label not found' });
      return;
    }
    const rawTxnIds = Array.isArray(b.transactionIds) ? b.transactionIds : null;
    if (!rawTxnIds) {
      res.status(400).json({ error: 'transactionIds must be an array' });
      return;
    }
    const txnIds = Array.from(
      new Set(
        rawTxnIds.map((v) => Number(v)).filter((n) => Number.isInteger(n) && n > 0)
      )
    );
    if (txnIds.length === 0) {
      res.json({ affected: 0 });
      return;
    }
    // Scope: only operate on transactions visible to this household.
    const visibleTxns = await Transaction.findAll({
      where: { id: { [Op.in]: txnIds }, ...visibleTransactionWhere(req) },
      attributes: ['id'],
    });
    const scopedIds = visibleTxns.map((t) => t.id);
    if (scopedIds.length === 0) {
      res.json({ affected: 0 });
      return;
    }

    let affected = 0;
    if (op === 'apply') {
      const existing = await TransactionLabel.findAll({
        where: { labelId, transactionId: { [Op.in]: scopedIds } },
        attributes: ['transactionId'],
      });
      const have = new Set(existing.map((r) => r.transactionId));
      const toCreate = scopedIds
        .filter((id) => !have.has(id))
        .map((transactionId) => ({ transactionId, labelId }));
      if (toCreate.length > 0) {
        await TransactionLabel.bulkCreate(toCreate, { ignoreDuplicates: true });
      }
      affected = toCreate.length;
    } else {
      affected = await TransactionLabel.destroy({
        where: { labelId, transactionId: { [Op.in]: scopedIds } },
      });
    }
    logTransactionEvent('bulk_labels', { op, labelId, requested: txnIds.length, affected });
    res.json({ affected });
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
        `SELECT TRIM(final_category) AS label, COUNT(*) AS "usageCount"
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

/**
 * GET /api/transactions/export?<filter-params>
 *
 * Streams all transactions matching the caller's filter as a CSV file.
 * Accepts the same filter query params as GET /api/transactions (dateFrom,
 * dateTo, category, accountId, currency, reviewFlag, importBatch, ids).
 *
 * Response:
 *   Content-Type: text/csv; charset=utf-8
 *   Content-Disposition: attachment; filename="cashflow-transactions-<YYYY-MM-DD>.csv"
 *
 * The response is streamed in cursor-paged batches so memory stays bounded
 * for large result sets (e.g. 50K+ rows).
 *
 * AC coverage: #1–#9, #12, #13.
 */
router.get('/export', async (req, res, next) => {
  try {
    if (!isValidDateFilter(req.query.dateFrom)) {
      res.status(400).json({ error: 'invalid dateFrom' });
      return;
    }
    if (!isValidDateFilter(req.query.dateTo)) {
      res.status(400).json({ error: 'invalid dateTo' });
      return;
    }

    const where = buildTransactionFilterWhere(req, req.query as Record<string, unknown>);

    logger.info(
      {
        householdId: isSuperadmin(req) ? null : currentAuth(req).household.id,
        filterKeys: Object.keys(req.query).join(','),
      },
      'transactions_export_started',
    );

    const rowCount = await streamCsvExport(res, where);

    logger.info(
      {
        householdId: isSuperadmin(req) ? null : currentAuth(req).household.id,
        rowCount,
      },
      'transactions_export_completed',
    );
  } catch (e) {
    // If headers haven't been sent yet, let express handle it normally.
    // If streaming already started (headers sent), we can't change status —
    // just end the response and log.
    if (res.headersSent) {
      logger.error({ err: e }, 'transactions_export_streaming_error');
      try { res.end(); } catch { /* ignore */ }
    } else {
      next(e);
    }
  }
});

router.get('/', async (req, res, next) => {
  try {
    if (!isValidDateFilter(req.query.dateFrom)) {
      res.status(400).json({ error: 'invalid dateFrom' });
      return;
    }
    if (!isValidDateFilter(req.query.dateTo)) {
      res.status(400).json({ error: 'invalid dateTo' });
      return;
    }

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
        `SELECT transaction_id AS "transactionId", COUNT(*) AS cnt FROM receipts WHERE transaction_id IN (${placeholders}) GROUP BY transaction_id`,
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
        `SELECT transaction_id AS "transactionId", extracted_note AS "extractedNote"
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
        const warnings = computeReceiptWarnings(row.extractedNote, txn);
        if (warnings.length) receiptWarningMap[row.transactionId] = warnings;
      }
    }

    const labelsMap = await loadLabelsForTransactions(txnIds);
    const summariesMap = await itemizedSummaries(txnIds);

    res.json({
      data: rows.map((row) => ({
        ...serializeTransaction(row),
        receiptCount: receiptCountMap[row.id] ?? 0,
        receiptWarnings: receiptWarningMap[row.id] ?? [],
        labels: labelsMap[row.id] ?? [],
        itemized: summariesMap.get(row.id) ?? null,
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

/**
 * POST /api/transactions/:id/labels { labelIds: number[] } — set the FULL label
 * set for one transaction (issue #270, AC #5). PUT-style replace semantics:
 * labels in the list that aren't yet applied are added; labels currently
 * applied but not in the list are removed. Idempotent. All labelIds must belong
 * to the caller's household; the transaction must be visible to it.
 *
 * Returns the resulting `{ id, name }[]` so the client can reconcile its
 * optimistic state.
 */
router.post('/:id/labels', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: 'Invalid id' });
      return;
    }
    const txn = await Transaction.findOne({
      where: { id, ...visibleTransactionWhere(req) },
    });
    if (!txn) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    const b = (req.body || {}) as Record<string, unknown>;
    const resolved = await resolveHouseholdLabelIds(req, b.labelIds);
    if (!resolved.ok) {
      res.status(400).json({ error: resolved.error });
      return;
    }
    const desired = new Set(resolved.ids);
    await sequelize.transaction(async (t) => {
      const current = await TransactionLabel.findAll({
        where: { transactionId: id },
        transaction: t,
      });
      const have = new Set(current.map((r) => r.labelId));
      const toRemove = [...have].filter((lid) => !desired.has(lid));
      const toAdd = [...desired].filter((lid) => !have.has(lid));
      if (toRemove.length > 0) {
        await TransactionLabel.destroy({
          where: { transactionId: id, labelId: { [Op.in]: toRemove } },
          transaction: t,
        });
      }
      if (toAdd.length > 0) {
        await TransactionLabel.bulkCreate(
          toAdd.map((labelId) => ({ transactionId: id, labelId })),
          { ignoreDuplicates: true, transaction: t },
        );
      }
    });
    const labelsMap = await loadLabelsForTransactions([id]);
    res.json({ labels: labelsMap[id] ?? [] });
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

    if (
      'taxTreatmentOverride' in b &&
      b.taxTreatmentOverride !== null &&
      !isTaxTreatment(b.taxTreatmentOverride)
    ) {
      res.status(400).json({ error: 'unknown tax treatment' });
      return;
    }

    const memSnap = captureMemorySnapshot(txn);
    const auditPrev = captureAuditFields(txn);
    await applyPatchBody(req, txn, b);

    recomputeTransactionAmounts(txn);
    // Version-history (#229): if the caller is accepting an AI suggestion,
    // tag the revision with source='ai_suggestion' and link the AiSuggestion
    // row. Otherwise it's a plain user_edit.
    const aiSuggestionId = Number(b.aiSuggestionId);
    const hasAiSuggestion = Number.isInteger(aiSuggestionId) && aiSuggestionId > 0;
    const { user } = currentAuth(req);
    await withRevisionContext(
      {
        changedByUserId: user.id,
        source: hasAiSuggestion ? 'ai_suggestion' : 'user_edit',
        aiSuggestionId: hasAiSuggestion ? aiSuggestionId : null,
      },
      () =>
        sequelize.transaction(async (t) => {
          await txn.save({ transaction: t });
          await syncLinkedLegTaxTreatment(req, txn, b, t);
        }),
    );
    scheduleMemoryFanoutIfNeeded(memSnap, txn);
    if (hasAiSuggestion) {
      await markTransactionSuggestionOutcome(req, aiSuggestionId, txn);
    }
    await txn.reload({
      include: [{ model: Account, as: 'account', attributes: ['id', 'name', 'shortCode'] }],
    });
    const auditNext = captureAuditFields(txn);
    const diff = diffPatchableFields(auditPrev, auditNext, AUDIT_DIFF_FIELDS);
    if (Object.keys(diff.after).length > 0) {
      const summaryFields = Object.keys(diff.after).slice(0, 3).join(', ');
      await recordAudit({
        req,
        action: AUDIT_ACTIONS.TransactionUpdated,
        entityType: AUDIT_ENTITY_TYPES.Transaction,
        entityId: txn.id,
        summary: `Updated ${summaryFields}`,
        before: diff.before,
        after: diff.after,
        metadata:
          Number.isInteger(aiSuggestionId) && aiSuggestionId > 0
            ? { aiSuggestionId }
            : undefined,
      });
      // Domain event for the stream (issue #238). The payload is the
      // set of changed fields keyed by field name — replay-friendly
      // and small. Consumers wanting the full before/after diff should
      // go to audit_log; this stream is for "what changed" reactions.
      await recordFinanceEvent({
        req,
        type: FINANCE_EVENT_TYPES.TransactionUpdated,
        entityType: FINANCE_EVENT_ENTITY_TYPES.Transaction,
        entityId: txn.id,
        payload: {
          changed: Object.keys(diff.after),
          after: diff.after,
          aiSuggestionId:
            Number.isInteger(aiSuggestionId) && aiSuggestionId > 0
              ? aiSuggestionId
              : null,
        },
      });
    }
    logTransactionEvent('patch_completed', { id });
    res.json(serializeTransaction(txn));
  } catch (e) {
    next(e);
  }
});

/**
 * POST /api/transactions/:id/re-enrich
 *
 * Re-runs the enrichment pipeline against a single transaction. Same safety
 * rules as the backfill (no override clobber, no reviewed_at change, review
 * flag only cleared when pipeline now confident and row was unreviewed).
 * Returns the updated serialized transaction.
 */
router.post('/:id/re-enrich', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: 'Invalid id' });
      return;
    }
    const txn = await Transaction.findOne({
      where: { id, ...visibleTransactionWhere(req) },
    });
    if (!txn) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    const result = await runBackfill({
      dryRun: false,
      noReviewFlag: false,
      reviewOnly: false,
      verbose: false,
      accountId: null,
      householdId: txn.householdId,
      transactionId: txn.id,
      limit: 1,
      batchSize: 1,
      dateFrom: null,
      dateTo: null,
    });
    logger.info({
      householdId: txn.householdId,
      transactionId: id,
      ...result,
    }, 'enrichment_single_reenrich');
    await txn.reload({
      include: [{ model: Account, as: 'account', attributes: ['id', 'name', 'shortCode'] }],
    });
    res.json(serializeTransaction(txn));
  } catch (e) {
    next(e);
  }
});

/**
 * GET /api/transactions/refund-suggestions
 *
 * Issue #215: review queue for refund matches.
 *
 * Returns rows from the caller's household where either:
 *   - The detector emitted a `refund-link-suggested` medium-confidence signal
 *     (canonical-brand match but cleaned merchants differ — needs human
 *     confirmation).
 *   - A refund already has an auto-linked original via the high-confidence
 *     `refund-link` path but the row remains unreviewed — so the user can
 *     audit the auto-links if desired.
 *
 * Suggestions are scoped to the visible-transaction set (so cross-household
 * leakage is impossible). Each row hydrates the linked original's merchant,
 * date and amount so the frontend can render a "Refund of $X at <merchant>
 * on <date>" preview without a second round-trip.
 */
router.get('/refund-suggestions', async (req, res, next) => {
  try {
    const { TransactionSignal } = await import('../models');
    // First pass: every refund row visible to the caller that's either
    // a) auto-linked but unreviewed, or b) has a suggested-link signal.
    const refunds = await Transaction.findAll({
      where: {
        ...visibleTransactionWhere(req),
        txnType: 'refund',
      },
      attributes: [
        'id',
        'date',
        'merchantClean',
        'merchantCanonical',
        'amount',
        'currency',
        'linkedTransactionId',
        'autoSource',
        'autoConfidence',
        'reviewFlag',
        'reviewedAt',
      ],
      order: [['date', 'DESC']],
      limit: 200,
      raw: true,
    });
    if (refunds.length === 0) {
      res.json({ data: [] });
      return;
    }
    const refundIds = refunds.map((r) => r.id);

    // Pull every refund-link-suggested signal for the matching refund ids
    // in one query so we can map them onto the rows.
    const suggestedSignals = await TransactionSignal.findAll({
      where: {
        transactionId: refundIds,
        source: 'refund-link-suggested',
      },
      raw: true,
    });
    const suggestedByRefundId = new Map<number, Array<{ linkedTransactionId: number | null; rationale: string | null }>>();
    for (const s of suggestedSignals) {
      const list = suggestedByRefundId.get(s.transactionId) ?? [];
      const fields = (s.fields ?? {}) as Record<string, unknown>;
      list.push({
        linkedTransactionId:
          typeof fields.linkedTransactionId === 'number' ? fields.linkedTransactionId : null,
        rationale: s.rationale ?? null,
      });
      suggestedByRefundId.set(s.transactionId, list);
    }

    // Collect every original id we may need to hydrate (auto-linked + suggested).
    const originalIds = new Set<number>();
    for (const r of refunds) {
      if (r.linkedTransactionId != null) originalIds.add(r.linkedTransactionId);
    }
    for (const list of suggestedByRefundId.values()) {
      for (const s of list) {
        if (s.linkedTransactionId != null) originalIds.add(s.linkedTransactionId);
      }
    }
    const originals = originalIds.size === 0
      ? []
      : await Transaction.findAll({
          where: { id: Array.from(originalIds), ...visibleTransactionWhere(req) },
          attributes: [
            'id',
            'date',
            'merchantClean',
            'merchantCanonical',
            'amount',
            'currency',
            'finalCategory',
          ],
          raw: true,
        });
    const originalById = new Map<number, (typeof originals)[number]>(
      originals.map((o) => [o.id, o]),
    );

    const out = refunds
      // A refund only appears in the queue when there's something to confirm:
      //   - it carries an auto-link via the detector AND remains unreviewed, OR
      //   - it has at least one suggested-link signal in the SQL fetch above
      .filter((r) => {
        const isAutoLink =
          r.linkedTransactionId != null && r.autoSource === 'refund-link' && !r.reviewedAt;
        const hasSuggestion = (suggestedByRefundId.get(r.id) ?? []).length > 0;
        return isAutoLink || hasSuggestion;
      })
      .map((r) => {
        const linkedOriginal =
          r.linkedTransactionId != null
            ? originalById.get(r.linkedTransactionId) ?? null
            : null;
        const suggestions = (suggestedByRefundId.get(r.id) ?? [])
          .map((s) => {
            const orig =
              s.linkedTransactionId != null ? originalById.get(s.linkedTransactionId) ?? null : null;
            if (!orig) return null;
            return {
              originalId: orig.id,
              originalDate: orig.date,
              originalMerchantClean: orig.merchantClean,
              originalAmount: Number(orig.amount),
              originalCurrency: orig.currency,
              originalFinalCategory: orig.finalCategory,
              rationale: s.rationale,
            };
          })
          .filter((s): s is NonNullable<typeof s> => s != null);
        return {
          refundId: r.id,
          refundDate: r.date,
          refundMerchantClean: r.merchantClean,
          refundAmount: Number(r.amount),
          refundCurrency: r.currency,
          autoSource: r.autoSource,
          autoConfidence: r.autoConfidence,
          reviewFlag: r.reviewFlag,
          linkedOriginal: linkedOriginal
            ? {
                id: linkedOriginal.id,
                date: linkedOriginal.date,
                merchantClean: linkedOriginal.merchantClean,
                amount: Number(linkedOriginal.amount),
                currency: linkedOriginal.currency,
                finalCategory: linkedOriginal.finalCategory,
              }
            : null,
          suggestions,
        };
      });
    res.json({ data: out });
  } catch (e) {
    next(e);
  }
});

/**
 * POST /api/transactions/:id/refund-link
 *
 * Issue #215: manually link a refund to its original purchase. The route
 * enforces:
 *   - both txns visible to the caller via `visibleTransactionWhere`
 *   - both txns share the same currency (a $50 USD refund can't offset a
 *     $50 CAD purchase)
 *   - the source (`:id`) is a refund (positive amount or txnType='refund')
 *   - the original (body.originalTransactionId) is a negative-amount purchase
 *
 * When successful, sets `linkedTransactionId` on the refund and stamps
 * `txnType='refund'` if the row was mis-classified. Returns the updated
 * serialized refund row.
 */
router.post('/:id/refund-link', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: 'Invalid id' });
      return;
    }
    const body = (req.body || {}) as { originalTransactionId?: unknown };
    const originalId = Number(body.originalTransactionId);
    if (!Number.isInteger(originalId) || originalId <= 0) {
      res.status(400).json({ error: 'originalTransactionId must be a positive integer' });
      return;
    }
    if (originalId === id) {
      res.status(400).json({ error: 'A transaction cannot link to itself' });
      return;
    }
    const refund = await Transaction.findOne({
      where: { id, ...visibleTransactionWhere(req) },
    });
    if (!refund) {
      res.status(404).json({ error: 'Refund not found' });
      return;
    }
    const original = await Transaction.findOne({
      where: { id: originalId, ...visibleTransactionWhere(req) },
    });
    if (!original) {
      res.status(404).json({ error: 'Original transaction not found' });
      return;
    }
    if (refund.currency !== original.currency) {
      res.status(400).json({ error: 'Refund and original currencies must match' });
      return;
    }
    const refundAmount = Number(refund.amount);
    const originalAmount = Number(original.amount);
    if (!(refundAmount >= 0)) {
      res.status(400).json({
        error: 'Refund row must have a non-negative amount (got ' + String(refund.amount) + ')',
      });
      return;
    }
    if (!(originalAmount < 0)) {
      res.status(400).json({
        error:
          'Original row must have a negative amount (got ' + String(original.amount) + ')',
      });
      return;
    }
    refund.linkedTransactionId = original.id;
    if (refund.txnType !== 'refund') refund.txnType = 'refund';
    // Manual links are user-confirmed → clear the review flag and stamp
    // reviewedAt so the row drops out of the queue immediately.
    refund.autoSource = 'refund-link';
    refund.autoConfidence = 'high';
    refund.reviewFlag = false;
    refund.reviewedAt = new Date();
    {
      const { user: refundUser } = currentAuth(req);
      await withRevisionContext(
        { changedByUserId: refundUser.id, source: 'refund_link' },
        () => refund.save(),
      );
    }
    await refund.reload({
      include: [{ model: Account, as: 'account', attributes: ['id', 'name', 'shortCode'] }],
    });
    res.json(serializeTransaction(refund));
  } catch (e) {
    next(e);
  }
});

/**
 * DELETE /api/transactions/:id/refund-link
 *
 * Issue #215: tear a refund off its linked original. Idempotent — succeeds
 * with the current row state even if the link was already null. The row's
 * `txnType` is preserved (still a refund, just unlinked).
 */
router.delete('/:id/refund-link', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: 'Invalid id' });
      return;
    }
    const refund = await Transaction.findOne({
      where: { id, ...visibleTransactionWhere(req) },
    });
    if (!refund) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    refund.linkedTransactionId = null;
    refund.autoSource = null;
    refund.autoConfidence = null;
    refund.reviewedAt = new Date();
    {
      const { user: refundUser } = currentAuth(req);
      await withRevisionContext(
        { changedByUserId: refundUser.id, source: 'refund_link' },
        () => refund.save(),
      );
    }
    await refund.reload({
      include: [{ model: Account, as: 'account', attributes: ['id', 'name', 'shortCode'] }],
    });
    res.json(serializeTransaction(refund));
  } catch (e) {
    next(e);
  }
});

/**
 * GET /api/transactions/:id/refund-details
 *
 * Issue #215: returns hydrated info about the original purchase linked from a
 * refund row, plus a derived "partial" flag (true when refund |amount| <
 * original |amount|). The frontend uses this to render the "Refund of $X at
 * <merchant>" inline badge.
 */
router.get('/:id/refund-details', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: 'Invalid id' });
      return;
    }
    const refund = await Transaction.findOne({
      where: { id, ...visibleTransactionWhere(req) },
    });
    if (!refund) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    if (refund.linkedTransactionId == null) {
      res.json({
        refundId: refund.id,
        linked: false,
        original: null,
        partial: null,
      });
      return;
    }
    const original = await Transaction.findOne({
      where: { id: refund.linkedTransactionId, ...visibleTransactionWhere(req) },
    });
    if (!original) {
      // Linked row exists but lies outside the caller's visible scope; report
      // "linked but inaccessible" rather than leak data via 404.
      res.json({
        refundId: refund.id,
        linked: true,
        original: null,
        partial: null,
      });
      return;
    }
    const refundAmount = Math.abs(Number(refund.amount));
    const originalAmount = Math.abs(Number(original.amount));
    res.json({
      refundId: refund.id,
      linked: true,
      partial: refundAmount < originalAmount,
      original: {
        id: original.id,
        date: original.date,
        merchantClean: original.merchantClean,
        merchantCanonical: original.merchantCanonical,
        amount: Number(original.amount),
        currency: original.currency,
        finalCategory: original.finalCategory,
      },
    });
  } catch (e) {
    next(e);
  }
});

/**
 * GET /api/transactions/:id/signals
 *
 * Returns all enrichment signals emitted for a single transaction, ordered by
 * creation time. Used by the per-row "Why" panel.
 */
router.get('/:id/signals', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: 'Invalid id' });
      return;
    }
    const txn = await Transaction.findOne({
      where: { id, ...visibleTransactionWhere(req) },
    });
    if (!txn) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    const { TransactionSignal } = await import('../models');
    const rows = await TransactionSignal.findAll({
      where: { transactionId: id },
      order: [['id', 'ASC']],
    });
    res.json(rows.map((r) => r.toJSON()));
  } catch (e) {
    next(e);
  }
});

/**
 * GET /api/transactions/:id/explanation
 *
 * Issue #230: per-field explanation of why a transaction has its current
 * category, split, business flag, notes, and review state.
 *
 * Unlike `/:id/signals` (which dumps raw enrichment signals JSON), this
 * endpoint returns a structured, human-readable explanation suitable for the
 * transaction detail panel. The actual reasoning is in
 * `backend/src/util/transactionExplanation.ts` — a pure function — so the
 * route is a thin shell that loads the rows the helper needs.
 *
 * Authorization: household-scoped via `visibleTransactionWhere(req)`. Both
 * the transaction and any joined rule/AI suggestion are filtered by the same
 * household, so cross-household leakage is impossible.
 */
router.get('/:id/explanation', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: 'Invalid id' });
      return;
    }
    const txn = await Transaction.findOne({
      where: { id, ...visibleTransactionWhere(req) },
    });
    if (!txn) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    const { TransactionSignal, Rule, AiSuggestion, User } = await import('../models');

    const [appliedRuleRow, signalRows, latestAcceptedAiRow] = await Promise.all([
      txn.appliedRuleId == null
        ? null
        : Rule.findOne({
            where: {
              id: txn.appliedRuleId,
              // Rules are household-scoped — same auth gate as the transaction.
              householdId: txn.householdId,
            },
          }),
      TransactionSignal.findAll({
        where: { transactionId: id },
        order: [['id', 'ASC']],
      }),
      AiSuggestion.findOne({
        where: {
          transactionId: id,
          kind: 'transaction_fields',
          status: ['accepted', 'edited'],
          householdId: txn.householdId,
        },
        order: [['updatedAt', 'DESC']],
      }),
    ]);

    // Best-effort actor lookup. We only know the creator (createdByUserId)
    // for now — true historical actor of each edit needs the finance audit
    // log (#228), which is not yet shipped. The helper falls back to a
    // displayName-less label when lookup returns null.
    let actorDisplayName: string | null = null;
    if (txn.createdByUserId != null) {
      const u = await User.findOne({
        where: { id: txn.createdByUserId },
        attributes: ['id', 'displayName'],
      });
      actorDisplayName = u?.displayName ?? null;
    }

    const { buildTransactionExplanation } = await import('../util/transactionExplanation');
    const explanation = buildTransactionExplanation({
      transaction: {
        id: txn.id,
        createdByUserId: txn.createdByUserId,
        createdAt: txn.createdAt,
        updatedAt: txn.updatedAt,
        appliedRuleId: txn.appliedRuleId,
        autoSource: txn.autoSource,
        autoCategory: txn.autoCategory,
        categoryOverride: txn.categoryOverride,
        finalCategory: txn.finalCategory,
        autoBusiness: txn.autoBusiness,
        businessOverride: txn.businessOverride,
        finalBusiness: txn.finalBusiness,
        autoSplitType: txn.autoSplitType,
        splitOverride: txn.splitOverride,
        finalSplitType: txn.finalSplitType,
        autoPctMe: txn.autoPctMe,
        pctMeOverride: txn.pctMeOverride,
        finalPctMe: txn.finalPctMe,
        autoPctPartner: txn.autoPctPartner,
        pctPartnerOverride: txn.pctPartnerOverride,
        finalPctPartner: txn.finalPctPartner,
        notes: txn.notes,
        reviewFlag: txn.reviewFlag,
        reviewedAt: txn.reviewedAt,
      },
      appliedRule:
        appliedRuleRow == null
          ? null
          : {
              id: appliedRuleRow.id,
              merchantPattern: appliedRuleRow.merchantPattern,
              category: appliedRuleRow.category,
              splitType: appliedRuleRow.splitType,
            },
      latestAcceptedAiSuggestion:
        latestAcceptedAiRow == null
          ? null
          : {
              id: latestAcceptedAiRow.id,
              createdAt: latestAcceptedAiRow.createdAt,
              status: latestAcceptedAiRow.status as 'accepted' | 'edited',
              model: latestAcceptedAiRow.model,
              output: latestAcceptedAiRow.output as {
                category?: string | null;
                business?: boolean | null;
                splitType?: string | null;
                notes?: string | null;
              } | null,
            },
      signals: signalRows.map((s) => ({
        source: s.source,
        confidence: s.confidence,
        fields: s.fields,
        rationale: s.rationale,
      })),
      actorLookup:
        actorDisplayName == null || txn.createdByUserId == null
          ? null
          : (uid) =>
              uid === txn.createdByUserId
                ? { id: uid, displayName: actorDisplayName! }
                : null,
    });

    res.json(explanation);
  } catch (e) {
    next(e);
  }
});

/**
 * GET /api/transactions/enrichment/stats
 *
 * Aggregate enrichment stats for the caller's household. Used by the
 * Settings dashboard.
 */
router.get('/enrichment/stats', async (req, res, next) => {
  try {
    const householdId = isSuperadmin(req) ? null : currentAuth(req).household.id;
    const hhClause = householdId == null ? '' : 'WHERE t.household_id = ?';
    const reps = householdId == null ? [] : [householdId];

    type CountRow = { k: string | null; n: number };

    async function bucket(column: string): Promise<Record<string, number>> {
      const rows = await sequelize.query<CountRow>(
        `SELECT ${column} AS k, COUNT(*) AS n FROM transactions t ${hhClause} GROUP BY ${column}`,
        { replacements: reps, type: QueryTypes.SELECT },
      );
      const out: Record<string, number> = {};
      for (const r of rows) {
        out[r.k ?? '(none)'] = Number(r.n);
      }
      return out;
    }

    const [
      totalRow,
      reviewTrueRow,
      reviewFalseRow,
      reviewedRow,
      recurringRow,
      refundLinkedRow,
      transferLinkedRow,
      bySource,
      byConfidence,
      byTxnType,
      topMerchants,
      topRules,
    ] = await Promise.all([
      sequelize.query<{ n: number }>(
        `SELECT COUNT(*) AS n FROM transactions t ${hhClause}`,
        { replacements: reps, type: QueryTypes.SELECT },
      ),
      sequelize.query<{ n: number }>(
        `SELECT COUNT(*) AS n FROM transactions t ${hhClause}${hhClause ? ' AND' : ' WHERE'} review_flag`,
        { replacements: reps, type: QueryTypes.SELECT },
      ),
      sequelize.query<{ n: number }>(
        `SELECT COUNT(*) AS n FROM transactions t ${hhClause}${hhClause ? ' AND' : ' WHERE'} NOT review_flag`,
        { replacements: reps, type: QueryTypes.SELECT },
      ),
      sequelize.query<{ n: number }>(
        `SELECT COUNT(*) AS n FROM transactions t ${hhClause}${hhClause ? ' AND' : ' WHERE'} reviewed_at IS NOT NULL`,
        { replacements: reps, type: QueryTypes.SELECT },
      ),
      sequelize.query<{ n: number }>(
        `SELECT COUNT(*) AS n FROM transactions t ${hhClause}${hhClause ? ' AND' : ' WHERE'} is_recurring`,
        { replacements: reps, type: QueryTypes.SELECT },
      ),
      sequelize.query<{ n: number }>(
        `SELECT COUNT(*) AS n FROM transactions t ${hhClause}${hhClause ? ' AND' : ' WHERE'} linked_transaction_id IS NOT NULL AND txn_type = 'refund'`,
        { replacements: reps, type: QueryTypes.SELECT },
      ),
      sequelize.query<{ n: number }>(
        `SELECT COUNT(*) AS n FROM transactions t ${hhClause}${hhClause ? ' AND' : ' WHERE'} linked_transaction_id IS NOT NULL AND txn_type = 'transfer'`,
        { replacements: reps, type: QueryTypes.SELECT },
      ),
      bucket('auto_source'),
      bucket('auto_confidence'),
      bucket('txn_type'),
      sequelize.query<{ name: string; n: number }>(
        `SELECT merchant_canonical AS name, COUNT(*) AS n FROM transactions t ${hhClause}${hhClause ? ' AND' : ' WHERE'} merchant_canonical IS NOT NULL GROUP BY merchant_canonical ORDER BY n DESC LIMIT 15`,
        { replacements: reps, type: QueryTypes.SELECT },
      ),
      sequelize.query<{ ruleId: number; pattern: string; category: string | null; n: number }>(
        `SELECT t.applied_rule_id AS "ruleId",
                r.merchant_pattern AS pattern,
                r.category AS category,
                COUNT(*) AS n
         FROM transactions t
         JOIN rules r ON r.id = t.applied_rule_id
         ${hhClause}${hhClause ? ' AND' : ' WHERE'} t.applied_rule_id IS NOT NULL
         GROUP BY t.applied_rule_id, r.merchant_pattern, r.category
         ORDER BY n DESC LIMIT 15`,
        { replacements: reps, type: QueryTypes.SELECT },
      ),
    ]);

    res.json({
      total: Number(totalRow[0]?.n ?? 0),
      reviewFlagTrue: Number(reviewTrueRow[0]?.n ?? 0),
      reviewFlagFalse: Number(reviewFalseRow[0]?.n ?? 0),
      reviewedTrue: Number(reviewedRow[0]?.n ?? 0),
      bySource,
      byConfidence,
      byTxnType,
      isRecurringCount: Number(recurringRow[0]?.n ?? 0),
      refundLinkedCount: Number(refundLinkedRow[0]?.n ?? 0),
      transferLinkedCount: Number(transferLinkedRow[0]?.n ?? 0),
      topCanonicalMerchants: topMerchants.map((r) => ({
        name: r.name,
        count: Number(r.n),
      })),
      topRules: topRules.map((r) => ({
        ruleId: r.ruleId,
        pattern: r.pattern,
        category: r.category,
        count: Number(r.n),
      })),
    });
  } catch (e) {
    next(e);
  }
});

/**
 * POST /api/transactions/enrichment/backfill
 *
 * Re-runs the enrichment pipeline against the caller's household's existing
 * transactions. Streams NDJSON (one row per line):
 *   - One `{kind: "progress", ...}` event per processed transaction
 *   - One `{kind: "error", txnId, message}` event per failed row
 *   - A final `{kind: "summary", processed, updated, ...}` event
 *
 * Body:
 *   { dryRun?: boolean, noReviewFlag?: boolean, reviewOnly?: boolean, limit?: number }
 */
router.post('/enrichment/backfill', async (req, res, next) => {
  try {
    const { household } = currentAuth(req);
    if (isBackfillInFlight(household.id)) {
      res.status(409).json({ error: 'Backfill already running for this household' });
      return;
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    const dateRe = /^\d{4}-\d{2}-\d{2}$/;
    const dateFrom =
      typeof body.dateFrom === 'string' && dateRe.test(body.dateFrom) ? body.dateFrom : null;
    const dateTo =
      typeof body.dateTo === 'string' && dateRe.test(body.dateTo) ? body.dateTo : null;
    const flags = {
      dryRun: Boolean(body.dryRun),
      noReviewFlag: Boolean(body.noReviewFlag),
      reviewOnly: Boolean(body.reviewOnly),
      verbose: false,
      accountId: null,
      householdId: household.id,
      limit:
        typeof body.limit === 'number' && Number.isFinite(body.limit) && body.limit > 0
          ? Math.floor(body.limit)
          : null,
      batchSize: 100,
      dateFrom,
      dateTo,
      // The manual "Run backfill" button should apply AI to rows the
      // deterministic pipeline leaves cold. runBackfill still gates this off on
      // dry-run, so a dry-run preview never calls OpenAI.
      ai: true,
    };

    // Content negotiation: NDJSON streaming only when the client explicitly
    // asks for it (Accept header or ?stream=1). Otherwise return a single
    // JSON summary, matching the original v1 endpoint shape. This keeps
    // pre-streaming-frontend clients working after the backend deploy.
    const accept = String(req.headers['accept'] ?? '').toLowerCase();
    const wantsStream =
      accept.includes('application/x-ndjson') ||
      accept.includes('application/ndjson') ||
      req.query.stream === '1';

    backfillRunning.add(household.id);
    const startedAt = Date.now();
    logger.info({
      householdId: household.id,
      dryRun: flags.dryRun,
      noReviewFlag: flags.noReviewFlag,
      reviewOnly: flags.reviewOnly,
      limit: flags.limit,
      streaming: wantsStream,
    }, 'enrichment_backfill_started');

    if (wantsStream) {
      res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('X-Accel-Buffering', 'no');
      function emit(obj: unknown) {
        res.write(`${JSON.stringify(obj)}\n`);
      }
      try {
        const result = await runBackfill(flags, {
          onProgress: (e) => emit({ kind: 'progress', ...e }),
          onError: (e) => emit({ kind: 'error', ...e }),
        });
        const durationMs = Date.now() - startedAt;
        logger.info({
          householdId: household.id,
          durationMs,
          ...result,
        }, 'enrichment_backfill_completed');
        emit({ kind: 'summary', ...result, durationMs, dryRun: flags.dryRun });
        res.end();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error({ householdId: household.id, message }, 'enrichment_backfill_failed');
        emit({ kind: 'error', message });
        res.end();
      } finally {
        backfillRunning.delete(household.id);
      }
      return;
    }

    // Non-streaming path: run to completion, return single JSON summary.
    try {
      const result = await runBackfill(flags);
      const durationMs = Date.now() - startedAt;
      logger.info({
        householdId: household.id,
        durationMs,
        ...result,
      }, 'enrichment_backfill_completed');
      res.json({ ...result, durationMs, dryRun: flags.dryRun });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ householdId: household.id, message }, 'enrichment_backfill_failed');
      next(err);
    } finally {
      backfillRunning.delete(household.id);
    }
  } catch (e) {
    next(e);
  }
});

// ---------------------------------------------------------------------------
// Counterparty backfill (issue #376) — retroactive sweep over legacy imports.
//
// #372 populates counterparty_raw only on *new* imports; households who
// imported years of statements before that shipped get value only going
// forward. This pair of routes exposes the backfill job to the Settings UI.
//
// Rate-limited to once per hour per household (the work is read-mostly but
// chatty; we use the ProviderJobLog as the rate-limit clock so it survives
// process restarts).
// ---------------------------------------------------------------------------

const COUNTERPARTY_BACKFILL_RATE_LIMIT_MS = 60 * 60 * 1000;

interface CounterpartyBackfillStatus {
  running: boolean;
  lastRunAt: string | null;
  nextAllowedAt: string | null;
  lastSummary: { processed: number; extracted: number; linked: number; elapsedMs: number } | null;
  rateLimitMs: number;
}

async function computeCounterpartyBackfillStatus(
  householdId: number,
): Promise<CounterpartyBackfillStatus> {
  const last = await getLastCounterpartyBackfillRun(householdId);
  const now = Date.now();
  let nextAllowedAt: string | null = null;
  if (last && last.status === 'ok') {
    const next = last.fetchedAt.getTime() + COUNTERPARTY_BACKFILL_RATE_LIMIT_MS;
    if (next > now) nextAllowedAt = new Date(next).toISOString();
  }
  return {
    running: isCounterpartyBackfillRunning(householdId),
    lastRunAt: last ? last.fetchedAt.toISOString() : null,
    nextAllowedAt,
    lastSummary: last ? last.summary : null,
    rateLimitMs: COUNTERPARTY_BACKFILL_RATE_LIMIT_MS,
  };
}

/**
 * GET /api/transactions/counterparty/backfill/status
 *
 * Read-only status for the Settings UI mount. Returns:
 *   - whether a backfill is currently running for this household
 *   - the last completed run's wall-clock timestamp + summary
 *   - the next-allowed timestamp (null when the 1h window has elapsed)
 *   - the rate-limit window in ms (so the client can render a countdown)
 */
router.get('/counterparty/backfill/status', async (req, res, next) => {
  try {
    const { household } = currentAuth(req);
    const status = await computeCounterpartyBackfillStatus(household.id);
    res.json(status);
  } catch (e) {
    next(e);
  }
});

/**
 * POST /api/transactions/counterparty/backfill
 *
 * Streams NDJSON events while the backfill runs:
 *   - `{kind: "progress", txnId, merchantRaw, counterpartyRaw}` per row
 *   - `{kind: "error", txnId, message}` per failed row
 *   - `{kind: "summary", processed, extracted, skipped, elapsedMs, dryRun}` at end
 *
 * Body (all optional):
 *   {
 *     dryRun?: boolean,   // when true, no DB write, no rate-limit log
 *     batchSize?: number  // 1-1000; defaults to 200
 *   }
 *
 * Returns:
 *   - 409 when another backfill is in flight for this household
 *   - 429 when the 1h rate limit hasn't elapsed since the last completed run
 */
router.post('/counterparty/backfill', async (req, res, next) => {
  try {
    const { household } = currentAuth(req);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const dryRun = Boolean(body.dryRun);
    const batchSize =
      typeof body.batchSize === 'number' && Number.isFinite(body.batchSize) && body.batchSize > 0
        ? Math.min(1000, Math.floor(body.batchSize))
        : 200;

    if (isCounterpartyBackfillRunning(household.id)) {
      res.status(409).json({ error: 'Counterparty backfill already running for this household' });
      return;
    }

    // Rate limit (real runs only — dry runs are cheap and never logged).
    if (!dryRun) {
      const status = await computeCounterpartyBackfillStatus(household.id);
      if (status.nextAllowedAt) {
        res.status(429).json({
          error: 'Counterparty backfill is rate-limited to once per hour per household',
          nextAllowedAt: status.nextAllowedAt,
          rateLimitMs: status.rateLimitMs,
        });
        return;
      }
    }

    const accept = String(req.headers['accept'] ?? '').toLowerCase();
    const wantsStream =
      accept.includes('application/x-ndjson') ||
      accept.includes('application/ndjson') ||
      req.query.stream === '1';

    logger.info(
      { householdId: household.id, dryRun, batchSize, streaming: wantsStream },
      'counterparty_backfill_started',
    );

    if (wantsStream) {
      res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('X-Accel-Buffering', 'no');
      function emit(obj: unknown) {
        res.write(`${JSON.stringify(obj)}\n`);
      }
      try {
        const result = await runCounterpartyBackfill(
          { householdId: household.id, batchSize, dryRun },
          {
            onProgress: (e) => emit({ kind: 'progress', ...e }),
            onError: (e) => emit({ kind: 'error', ...e }),
          },
        );
        emit({ kind: 'summary', ...result });
        res.end();
      } catch (err) {
        if (err instanceof CounterpartyBackfillInFlightError) {
          emit({ kind: 'error', message: err.message });
          res.end();
          return;
        }
        const message = err instanceof Error ? err.message : String(err);
        logger.error(
          { householdId: household.id, message },
          'counterparty_backfill_failed',
        );
        emit({ kind: 'error', message });
        res.end();
      }
      return;
    }

    // Non-streaming path: single JSON summary on completion.
    try {
      const result = await runCounterpartyBackfill({
        householdId: household.id,
        batchSize,
        dryRun,
      });
      res.json(result);
    } catch (err) {
      if (err instanceof CounterpartyBackfillInFlightError) {
        res.status(409).json({ error: err.message });
        return;
      }
      next(err);
    }
  } catch (e) {
    next(e);
  }
});

// ---------------------------------------------------------------------------
// Interac e-Transfer counterparty sync (Task 5 of Interac feature).
//
// Three routes:
//   POST /interac-counterparty/sync    — run (or dry-run) the sync job
//   GET  /interac-counterparty/status  — last run + running flag
//   POST /:id/interac-counterparty/accept — accept a review suggestion
//
// The two literal-path routes are registered BEFORE the /:id wildcard block
// so Express matches them before capturing the path segment as an id.
// ---------------------------------------------------------------------------

/**
 * POST /api/transactions/interac-counterparty/sync
 *
 * Runs `runInteracCounterpartySync` for the caller's household.
 * Body: { dryRun?: boolean }
 *
 * Returns the InteracSyncResult on success (200).
 * Returns 409 if a sync is already in flight for this household.
 */
router.post('/interac-counterparty/sync', async (req, res, next) => {
  try {
    const { user, household } = currentAuth(req);
    if (isInteracSyncRunning(household.id)) {
      res.status(409).json({ error: 'Interac sync already running for this household' });
      return;
    }
    const dryRun = Boolean((req.body ?? {}).dryRun);
    try {
      const result = await runInteracCounterpartySync({
        householdId: household.id,
        userId: user.id,
        dryRun,
      });
      res.json(result);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.toLowerCase().includes('already running')) {
        res.status(409).json({ error: msg });
        return;
      }
      next(e);
    }
  } catch (e) {
    next(e);
  }
});

/**
 * GET /api/transactions/interac-counterparty/status
 *
 * Returns:
 *   { running: boolean, lastRunAt: string|null, lastSummary: object|null }
 *
 * `lastSummary` is the JSON-encoded summary from the most recent
 * ProviderJobLog row, or null when no run has completed yet.
 */
router.get('/interac-counterparty/status', async (req, res, next) => {
  try {
    const { household } = currentAuth(req);
    const row = await ProviderJobLog.findOne({
      where: {
        provider: INTERAC_SYNC_PROVIDER,
        symbol: String(household.id),
      },
      order: [
        ['fetchedAt', 'DESC'],
        ['id', 'DESC'],
      ],
    });
    let lastSummary: unknown = null;
    if (row?.errorMessage) {
      try {
        lastSummary = JSON.parse(row.errorMessage) as unknown;
      } catch {
        // Malformed log row — surface null so the UI still renders.
      }
    }
    res.json({
      running: isInteracSyncRunning(household.id),
      lastRunAt: row ? row.fetchedAt.toISOString() : null,
      lastSummary,
    });
  } catch (e) {
    next(e);
  }
});

/**
 * POST /api/transactions/:id/interac-counterparty/accept
 *
 * Accepts a `counterparty_email_match` AiSuggestion for the given transaction.
 * Body: { suggestionId: number }
 *
 * - Sets `counterpartyRaw` to the suggestion's output.name on the transaction.
 * - If `!output.isSelf`, find-or-creates a Contact and links it.
 * - Marks the suggestion as 'accepted'.
 * - Returns { transaction: serialized, suggestionId }.
 */
router.post('/:id/interac-counterparty/accept', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: 'Invalid id' });
      return;
    }
    const { household } = currentAuth(req);
    const body = (req.body || {}) as { suggestionId?: unknown };
    const suggestionId = Number(body.suggestionId);
    if (!Number.isInteger(suggestionId) || suggestionId <= 0) {
      res.status(400).json({ error: 'suggestionId must be a positive integer' });
      return;
    }
    const suggestion = await AiSuggestion.findOne({
      where: {
        id: suggestionId,
        householdId: household.id,
        kind: 'counterparty_email_match',
        status: 'suggested',
      },
    });
    if (!suggestion) {
      res.status(404).json({ error: 'Suggestion not found' });
      return;
    }
    const txn = await Transaction.findOne({
      where: { id, ...visibleTransactionWhere(req) },
    });
    if (!txn) {
      res.status(404).json({ error: 'Transaction not found' });
      return;
    }
    if (suggestion.transactionId !== id) {
      res.status(400).json({ error: 'Suggestion does not belong to this transaction' });
      return;
    }
    const output = suggestion.output as { name: string; isSelf: boolean };
    const name = typeof output?.name === 'string' ? output.name.trim() : '';
    if (!name) {
      res.status(400).json({ error: 'Suggestion has no usable counterparty name' });
      return;
    }
    txn.counterpartyRaw = name;
    if (!output.isSelf) {
      const contact = await findOrCreateContactByName(household.id, name);
      txn.counterpartyContactId = contact.id;
    }
    await txn.save();
    suggestion.status = 'accepted';
    await suggestion.save();
    res.json({ transaction: serializeTransaction(txn), suggestionId });
  } catch (e) {
    next(e);
  }
});

/**
 * GET /api/transactions/:id/revisions
 *
 * Issue #229: version-history timeline for a single transaction. Returns
 * an ordered list of revisions (oldest -> newest), each with the recorded
 * field-level diff plus actor/source provenance. The Sequelize
 * beforeUpdate/afterUpdate hooks on Transaction emit one revision per
 * touched-and-changed save; nothing is emitted when the patch is a no-op.
 *
 * Response shape:
 *   { data: [{
 *     id, transactionId, source, changedByUserId, aiSuggestionId,
 *     changes: [{ field, before, after }, ...],
 *     createdAt
 *   }, ...] }
 */
router.get('/:id/revisions', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: 'Invalid id' });
      return;
    }
    const txn = await Transaction.findOne({
      where: { id, ...visibleTransactionWhere(req) },
      attributes: ['id', 'householdId'],
    });
    if (!txn) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    const rows = await TransactionRevision.findAll({
      where: { transactionId: id },
      order: [
        ['createdAt', 'ASC'],
        ['id', 'ASC'],
      ],
      limit: 500,
    });
    res.json({
      data: rows.map((r) => ({
        id: r.id,
        transactionId: r.transactionId,
        source: r.source,
        changedByUserId: r.changedByUserId,
        aiSuggestionId: r.aiSuggestionId,
        changes: parseRevisionChanges(r.changes),
        createdAt: r.createdAt,
      })),
    });
  } catch (e) {
    next(e);
  }
});

/**
 * POST /api/transactions/:id/revisions/:rid/restore
 *
 * Issue #229: restore one or more supported fields from a prior revision.
 * The body specifies which fields to restore -- if omitted, every field on
 * the revision that intersects {@link RESTORABLE_FIELDS} is restored.
 * Returns the updated serialized transaction.
 *
 * Restoring a value emits a NEW revision with source='restore' so the
 * timeline shows the round-trip rather than silently rolling history.
 *
 * Validation:
 *   - 400 if `fields` is provided and contains any non-restorable field.
 *   - 400 if no restorable fields are present on the target revision.
 *   - 404 if the transaction is not visible, or the revision id does not
 *     belong to the same transaction (anti-tamper).
 *
 * Rate-limited via {@link aiSuggestLimiter} -- restore is an
 * authenticated mutating endpoint, so CodeQL's no-unrate-limited rule
 * applies even though this is not an AI call.
 */
router.post('/:id/revisions/:rid/restore', aiSuggestLimiter, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const rid = Number(req.params.rid);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: 'Invalid transaction id' });
      return;
    }
    if (!Number.isInteger(rid) || rid <= 0) {
      res.status(400).json({ error: 'Invalid revision id' });
      return;
    }
    const body = (req.body || {}) as { fields?: unknown };
    let requestedFields: RevisionedField[] | null = null;
    if (Array.isArray(body.fields)) {
      const invalid: string[] = [];
      requestedFields = [];
      for (const raw of body.fields) {
        const name = String(raw);
        if ((RESTORABLE_FIELDS as readonly string[]).includes(name)) {
          requestedFields.push(name as RevisionedField);
        } else {
          invalid.push(name);
        }
      }
      if (invalid.length > 0) {
        res.status(400).json({
          error: `Unsupported restore field(s): ${invalid.join(', ')}`,
          restorable: RESTORABLE_FIELDS,
        });
        return;
      }
      if (requestedFields.length === 0) {
        res.status(400).json({ error: 'fields must include at least one entry' });
        return;
      }
    }

    const txn = await Transaction.findOne({
      where: { id, ...visibleTransactionWhere(req) },
    });
    if (!txn) {
      res.status(404).json({ error: 'Transaction not found' });
      return;
    }

    const revision = await TransactionRevision.findOne({ where: { id: rid } });
    if (!revision || revision.transactionId !== id) {
      res.status(404).json({ error: 'Revision not found' });
      return;
    }

    const changes = parseRevisionChanges(revision.changes);
    if (changes.length === 0) {
      res.status(400).json({ error: 'Revision has no recorded changes' });
      return;
    }

    // Restore the `before` value for each field that is (a) on the revision,
    // (b) in RESTORABLE_FIELDS, and (c) either unfiltered or in the
    // explicit `fields` allowlist. Anything else is silently ignored so a
    // legacy revision with a now-unsupported field doesn't fail the whole
    // restore.
    const applied: Array<{ field: RevisionedField; restoredTo: unknown }> = [];
    for (const entry of changes) {
      const field = entry.field as RevisionedField;
      if (!(RESTORABLE_FIELDS as readonly string[]).includes(field)) continue;
      if (requestedFields != null && !requestedFields.includes(field)) continue;
      txn.set(field as never, entry.before as never);
      applied.push({ field, restoredTo: entry.before });
    }
    if (applied.length === 0) {
      res.status(400).json({
        error: 'Revision has no restorable fields',
        restorable: RESTORABLE_FIELDS,
      });
      return;
    }

    recomputeTransactionAmounts(txn);
    const { user } = currentAuth(req);
    await withRevisionContext(
      {
        changedByUserId: user.id,
        source: 'restore',
      },
      () => txn.save(),
    );
    await txn.reload({
      include: [{ model: Account, as: 'account', attributes: ['id', 'name', 'shortCode'] }],
    });
    res.json({
      transaction: serializeTransaction(txn),
      restored: applied,
    });
  } catch (e) {
    next(e);
  }
});

/**
 * POST /api/transactions/:id/counterparty/promote
 *
 * Promotes the txn's raw counterparty text into a structured Contact link
 * (#372). Two modes:
 *
 *  - `{ contactId: <existing> }` — link to an existing Contact owned by
 *    the user's household. 404 if the Contact does not belong here.
 *  - `{}` (no contactId) — find-or-create a Contact from `counterparty_raw`
 *    by its normalized name (reusing an existing match if present).
 *    Requires `counterparty_raw` to be set.
 *
 * Contact dedup key is `(householdId, normalized_name)` (lowercase +
 * whitespace-collapsed) via `findOrCreateContactByName`, so `'Jane Doe'`
 * and `'JANE DOE'` collapse to one Contact.
 */
router.post('/:id/counterparty/promote', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: 'Invalid id' });
      return;
    }
    const { household } = currentAuth(req);
    const txn = await Transaction.findOne({
      where: { id, ...visibleTransactionWhere(req) },
    });
    if (!txn) {
      res.status(404).json({ error: 'Transaction not found' });
      return;
    }
    const body = (req.body || {}) as { contactId?: unknown };
    let contact: Contact | null = null;
    if (body.contactId != null) {
      const contactId = Number(body.contactId);
      if (!Number.isInteger(contactId) || contactId <= 0) {
        res.status(400).json({ error: 'contactId must be a positive integer' });
        return;
      }
      contact = await Contact.findOne({
        where: { id: contactId, householdId: household.id },
      });
      if (!contact) {
        res.status(404).json({ error: 'Contact not found' });
        return;
      }
    } else {
      const raw = (txn.counterpartyRaw ?? '').trim();
      if (!raw) {
        res.status(400).json({
          error: 'Transaction has no counterpartyRaw; supply contactId to link manually',
        });
        return;
      }
      contact = await findOrCreateContactByName(household.id, raw);
    }
    txn.counterpartyContactId = contact.id;
    await txn.save();
    res.json({
      transaction: serializeTransaction(txn),
      contact,
    });
  } catch (e) {
    next(e);
  }
});

/**
 * POST /api/transactions/counterparty/promote-bulk
 *
 * "Create Contact and link all" action behind issue #373's
 * counterparty-promotion suggestion. Walks every un-linked transaction
 * in the caller's household whose normalized counterpartyRaw matches the
 * supplied `normalizedName` (lowercase + collapsed whitespace) within
 * the trailing 90-day window, creates (or reuses) a Contact, and links
 * the whole set in a single transaction.
 *
 * Body:
 *   - `normalizedName`: REQUIRED, the normalized key the user clicked.
 *     Server re-normalizes it defensively against the client value.
 *   - `contactId`: OPTIONAL, link to an existing Contact owned by the
 *     caller's household. When omitted, the route auto-creates a
 *     Contact whose name is the most-recent matching txn's raw
 *     counterparty value (preserving the casing the user has seen on
 *     their statements).
 *
 * Returns:
 *   - `contact`: the linked Contact row.
 *   - `linkedCount`: how many transactions were linked.
 *   - `transactionIds`: ids that were linked (capped at 200 for sanity).
 *
 * Authorization: all touched txns must pass `visibleTransactionWhere`.
 * Cross-household txns are silently excluded by that gate; the route
 * never reveals their existence.
 */
router.post('/counterparty/promote-bulk', async (req, res, next) => {
  try {
    const { household } = currentAuth(req);
    const body = (req.body || {}) as { normalizedName?: unknown; contactId?: unknown };
    const normalized = normalizeCounterpartyName(
      typeof body.normalizedName === 'string' ? body.normalizedName : '',
    );
    if (!normalized) {
      res.status(400).json({ error: 'normalizedName is required' });
      return;
    }
    // 90-day window matches the detector. Computing the cutoff here
    // (instead of pushing it into the detector) keeps the route a single
    // SQL query and lets the integration tests pin a known `now`.
    const cutoff = new Date(
      Date.now() - COUNTERPARTY_PROMOTION_WINDOW_DAYS * 24 * 60 * 60 * 1000,
    )
      .toISOString()
      .slice(0, 10);

    const result = await sequelize.transaction(async (t) => {
      // Pull the matching txns up front (within the window, unlinked,
      // exact normalized match). raw:false so Sequelize keeps it as model
      // instances — needed for the .save() loop below.
      const matchedAll = await Transaction.findAll({
        where: {
          ...visibleTransactionWhere(req),
          counterpartyContactId: null,
          date: { [Op.gte]: cutoff },
        },
        transaction: t,
      });
      const matched = matchedAll.filter(
        (m) => normalizeCounterpartyName(m.counterpartyRaw) === normalized,
      );

      // Resolve the Contact: explicit id, or auto-create from the most
      // recent matching txn's raw value.
      let contact: Contact | null = null;
      if (body.contactId != null) {
        const contactId = Number(body.contactId);
        if (!Number.isInteger(contactId) || contactId <= 0) {
          const err = new Error('contactId must be a positive integer') as Error & {
            status?: number;
          };
          err.status = 400;
          throw err;
        }
        contact = await Contact.findOne({
          where: { id: contactId, householdId: household.id },
          transaction: t,
        });
        if (!contact) {
          const err = new Error('Contact not found') as Error & { status?: number };
          err.status = 404;
          throw err;
        }
      } else {
        // Auto-create: pick the most recent txn's raw counterparty for
        // the Contact name to preserve casing (`Jane Doe` vs `JANE DOE`).
        // If no candidates remain (race with another promote), 404.
        const newest = matched.sort((a, b) => {
          if (a.date === b.date) return b.id - a.id;
          return a.date < b.date ? 1 : -1;
        })[0];
        if (!newest) {
          res.status(404).json({
            error: 'No matching un-linked transactions in the trailing 90 days',
          });
          return null;
        }
        const rawName = (newest.counterpartyRaw ?? '').trim();
        contact = await findOrCreateContactByName(household.id, rawName, { transaction: t });
      }

      // Link every matching txn. Iterate so per-row save triggers
      // revision tracking (the same way the single-txn promote does it
      // implicitly via Sequelize). bulkUpdate would skip revisions.
      const linkedIds: number[] = [];
      for (const txn of matched) {
        if (txn.counterpartyContactId === contact.id) continue;
        txn.counterpartyContactId = contact.id;
        await txn.save({ transaction: t });
        linkedIds.push(txn.id);
        if (linkedIds.length >= 200) break;
      }
      return { contact, linkedIds };
    });
    if (result == null) return;
    res.json({
      contact: result.contact,
      linkedCount: result.linkedIds.length,
      transactionIds: result.linkedIds,
    });
  } catch (e) {
    next(e);
  }
});

export default router;
