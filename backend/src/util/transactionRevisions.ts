/**
 * Transaction version-history recorder (#229).
 *
 * Listens for changes on tracked Transaction fields and writes a single
 * {@link TransactionRevision} row inside the same SQL transaction as the
 * parent save. Tracked fields cover everything a user can edit through
 * the UI plus a handful of system-set columns that are useful to audit
 * (refund linking, recurring flag, review state).
 *
 * Provenance (who/why) is supplied via {@link withRevisionContext} — an
 * AsyncLocalStorage scope that route handlers wrap around the actual save.
 * If no context is active (e.g. an internal job that didn't opt in) we
 * fall back to source='system' with a null actor.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Transaction as SqlTransaction } from 'sequelize';
import type { Transaction } from '../models/Transaction';
import {
  TransactionRevision,
  type TransactionFieldChange,
  type TransactionRevisionSource,
} from '../models/TransactionRevision';
import { logger } from '../observability/logger';

/**
 * Fields whose pre/post values are persisted to {@link TransactionRevision}.
 * Order is intentional — the timeline UI renders changes in this order so
 * the most common edits (category, split, notes, review state) appear first.
 */
export const REVISIONED_FIELDS = [
  'categoryOverride',
  'finalCategory',
  'businessOverride',
  'finalBusiness',
  'splitOverride',
  'finalSplitType',
  'pctMeOverride',
  'pctPartnerOverride',
  'notes',
  'reviewFlag',
  'reviewedAt',
  'visibility',
  'ownershipType',
  'ownershipContactId',
  'linkedTransactionId',
  'txnType',
  'autoSource',
  'autoConfidence',
  'isRecurring',
] as const;

export type RevisionedField = (typeof REVISIONED_FIELDS)[number];

/**
 * Subset of {@link REVISIONED_FIELDS} that the restore endpoint will
 * roll back to a prior value. Restricted to user-meaningful scalars so
 * we never accidentally restore an enrichment-managed flag.
 */
export const RESTORABLE_FIELDS: readonly RevisionedField[] = [
  'categoryOverride',
  'businessOverride',
  'splitOverride',
  'pctMeOverride',
  'pctPartnerOverride',
  'notes',
  'reviewFlag',
] as const;

export interface RevisionContext {
  changedByUserId: number | null;
  source: TransactionRevisionSource;
  aiSuggestionId?: number | null;
}

const revisionAls = new AsyncLocalStorage<RevisionContext>();

/**
 * Run `fn` with the supplied revision provenance active. The
 * Transaction-model save hook reads this via {@link currentRevisionContext}
 * to attribute the row.
 */
export function withRevisionContext<T>(
  ctx: RevisionContext,
  fn: () => T,
): T {
  return revisionAls.run(ctx, fn);
}

export function currentRevisionContext(): RevisionContext | undefined {
  return revisionAls.getStore();
}

function normalize(value: unknown): unknown {
  // Sequelize DATE columns come back as Date objects; serialize so the JSON
  // diff round-trips cleanly. Decimals come back as strings — leave them.
  if (value instanceof Date) return value.toISOString();
  return value === undefined ? null : value;
}

/**
 * Build the field-level diff for a Transaction instance about to be saved.
 * Returns `null` when nothing tracked changed (so we never write empty
 * revision rows). For Sequelize 6 we read `previous(key)` for the prior
 * value and `get(key)` for the new value.
 */
export function buildTransactionDiff(
  txn: Transaction,
): TransactionFieldChange[] | null {
  const out: TransactionFieldChange[] = [];
  for (const field of REVISIONED_FIELDS) {
    const before = normalize(txn.previous(field as never));
    const after = normalize(txn.get(field as never));
    if (before === after) continue;
    // Decimal columns return strings — compare by string identity is fine,
    // but normalize null/undefined boundary.
    if (
      (before == null || before === '') &&
      (after == null || after === '')
    ) {
      continue;
    }
    out.push({ field, before, after });
  }
  return out.length === 0 ? null : out;
}

export async function recordTransactionRevision(
  txn: Transaction,
  diff: TransactionFieldChange[],
  options: {
    transaction?: SqlTransaction | null;
    fallback?: Partial<RevisionContext>;
  } = {},
): Promise<TransactionRevision | null> {
  const ctx = currentRevisionContext();
  const source: TransactionRevisionSource =
    ctx?.source ?? options.fallback?.source ?? 'system';
  const changedByUserId =
    ctx?.changedByUserId ?? options.fallback?.changedByUserId ?? null;
  const aiSuggestionId =
    ctx?.aiSuggestionId ?? options.fallback?.aiSuggestionId ?? null;
  try {
    return await TransactionRevision.create(
      {
        transactionId: txn.id,
        householdId: txn.householdId,
        changedByUserId,
        source,
        aiSuggestionId,
        changes: JSON.stringify(diff),
      },
      { transaction: options.transaction ?? undefined },
    );
  } catch (err) {
    // Never let a revision-write failure break the underlying save. Log and
    // continue — the original change still lands; we just lose the audit row.
    logger.warn(
      {
        err,
        transactionId: txn.id,
        source,
      },
      'transaction_revision_record_failed',
    );
    return null;
  }
}

/**
 * Parse a revision row's `changes` blob into a typed diff array. Defensive
 * against legacy/corrupt data — returns an empty array on parse failure.
 */
export function parseRevisionChanges(raw: string | null | undefined): TransactionFieldChange[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry): entry is TransactionFieldChange =>
        typeof entry === 'object' &&
        entry !== null &&
        'field' in entry &&
        'before' in entry &&
        'after' in entry,
    );
  } catch {
    return [];
  }
}
