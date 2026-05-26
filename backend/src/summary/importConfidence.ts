/**
 * Import-confidence aggregation (#214).
 *
 * Pure aggregation module driving:
 *  - GET /api/import/health  — overall clean / needs-review percentages and
 *                              counts by flag for the active household.
 *  - GET /api/import/history — per-batch clean / needs-review breakdown
 *                              (extends the history table).
 *
 * NULL `import_confidence` (legacy rows imported before #214) is reported as
 * 'unknown' so the dashboard tile can hide them or show a backfill hint
 * without breaking when historical data has not yet been classified.
 *
 * Cross-household isolation is enforced by the caller via the
 * `householdScope` WHERE supplied by `visibleTransactionWhere`.
 */
import { Op, type WhereOptions } from 'sequelize';
import { Transaction } from '../models';
import {
  IMPORT_CONFIDENCE_FLAGS,
  type ImportConfidenceFlag,
  deserializeFlags,
} from '../import/computeImportConfidence';

export type ImportHealthState = 'clean' | 'needs_review' | 'unknown';

export interface ImportHealthResult {
  /** Total visible transactions in scope (any state, including unknown). */
  total: number;
  /** Rows with import_confidence='clean'. */
  clean: number;
  /** Rows with import_confidence='needs_review'. */
  needsReview: number;
  /** Rows with NULL import_confidence (legacy / not yet classified). */
  unknown: number;
  /** clean / (clean + needsReview). 0 when no classified rows yet. Range 0..1. */
  cleanPercent: number;
  /** Count of rows that fired each named flag (sparse — missing flags = 0). */
  byFlag: Record<ImportConfidenceFlag, number>;
  /** ISO currency code when filtered, or null when crossing currencies. */
  currency: string | null;
}

export interface ImportHealthInput {
  householdScope: WhereOptions;
  currency: string | null;
}

/**
 * Aggregate the import-health snapshot for the requested scope.
 *
 * One pass over the in-scope transactions. The flag-counting step deserializes
 * the JSON-encoded `import_confidence_flags` text column per row — cheap
 * because flag arrays are tiny (≤6 tokens). If this ever becomes a hotspot we
 * can fan out per-flag aggregate queries instead.
 */
export async function aggregateImportHealth(
  input: ImportHealthInput,
): Promise<ImportHealthResult> {
  const where: Record<string | symbol, unknown> = { ...input.householdScope };
  if (input.currency) where.currency = input.currency;

  const rows = await Transaction.findAll({
    where: where as WhereOptions,
    attributes: ['importConfidence', 'importConfidenceFlags'],
    raw: true,
  });

  const byFlag = createEmptyFlagCounter();
  let clean = 0;
  let needsReview = 0;
  let unknown = 0;
  for (const row of rows) {
    const state = (row as unknown as { importConfidence: string | null }).importConfidence;
    const flagsRaw = (row as unknown as { importConfidenceFlags: string | null }).importConfidenceFlags;
    if (state === 'clean') clean += 1;
    else if (state === 'needs_review') needsReview += 1;
    else unknown += 1;
    for (const flag of deserializeFlags(flagsRaw)) {
      byFlag[flag] += 1;
    }
  }

  const classifiedDenominator = clean + needsReview;
  const cleanPercent =
    classifiedDenominator === 0 ? 0 : clean / classifiedDenominator;

  return {
    total: rows.length,
    clean,
    needsReview,
    unknown,
    cleanPercent,
    byFlag,
    currency: input.currency,
  };
}

export interface BatchHealthRow {
  batchLabel: string;
  total: number;
  clean: number;
  needsReview: number;
  unknown: number;
}

/**
 * Per-batch clean / needs-review counts for the supplied batch labels. Used
 * to enrich the `/api/import/history` response. Single grouped query over
 * `import_batch + import_confidence` so it stays O(rows-in-scope).
 *
 * Returns a Map keyed by batch label so the caller can join against the
 * ImportHistory rows.
 */
export async function aggregateBatchHealth(
  input: ImportHealthInput & { batchLabels: string[] },
): Promise<Map<string, BatchHealthRow>> {
  const out = new Map<string, BatchHealthRow>();
  if (input.batchLabels.length === 0) return out;

  const where: Record<string | symbol, unknown> = {
    ...input.householdScope,
    importBatch: { [Op.in]: input.batchLabels },
  };
  if (input.currency) where.currency = input.currency;

  const rows = await Transaction.findAll({
    where: where as WhereOptions,
    attributes: ['importBatch', 'importConfidence'],
    raw: true,
  });

  for (const row of rows) {
    const r = row as unknown as { importBatch: string; importConfidence: string | null };
    let bucket = out.get(r.importBatch);
    if (!bucket) {
      bucket = {
        batchLabel: r.importBatch,
        total: 0,
        clean: 0,
        needsReview: 0,
        unknown: 0,
      };
      out.set(r.importBatch, bucket);
    }
    bucket.total += 1;
    if (r.importConfidence === 'clean') bucket.clean += 1;
    else if (r.importConfidence === 'needs_review') bucket.needsReview += 1;
    else bucket.unknown += 1;
  }
  return out;
}

function createEmptyFlagCounter(): Record<ImportConfidenceFlag, number> {
  const out: Partial<Record<ImportConfidenceFlag, number>> = {};
  for (const flag of IMPORT_CONFIDENCE_FLAGS) out[flag] = 0;
  return out as Record<ImportConfidenceFlag, number>;
}
