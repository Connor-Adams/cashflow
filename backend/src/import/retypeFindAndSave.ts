/**
 * Re-typing historical RBC "Find & Save" sweeps stored as grocery purchases.
 *
 * RBC Find & Save (NOMI) moves a few dollars from chequing into the customer's
 * own Find & Save savings account. Prod at the time of writing: 494 rows
 * "TO FIND & SAVE" on RBC Day to Day Banking 6985 (2019-06 to 2026-04,
 * -26,801.00) typed `purchase` and categorised Groceries by the AI fallback,
 * plus two already typed `transfer` whose category is not Transfer (one
 * linked "TO FIND & SAVE" still Groceries, one "AUTO TRANSFER FROM FIND &
 * SAVE" with no category).
 * `detectTypeStage` now types the narrative `transfer` with category Transfer.
 *
 * The decision is delegated to the detector rather than re-implemented here, so
 * this cannot drift from the import path. It only touches rows whose narrative
 * matches the Find & Save rule, only sets them to transfer / Transfer, and only
 * on a high-confidence detection.
 *
 * Rows a person has touched are never written: a row with `reviewedAt`, a
 * `categoryOverride`, or any revision from a user-initiated source is reported
 * as skipped instead.
 *
 * Every write is an instance save, so each touched row gets a
 * TransactionRevision.
 */
import { Op, fn, col, where, type Transaction as DbTransaction } from 'sequelize';
import { Transaction, TransactionRevision, sequelize } from '../models';
import type { TransactionRevisionSource } from '../models/TransactionRevision';
import { recomputeTransactionAmounts } from './calculateShares';
import { FIND_AND_SAVE_RE } from './enrichment/detectTypeStage';
import { confidentNarrativeType, type RetypeCandidate } from './retypeCardPayments';
import { RetypeAborted } from './retypeBrokerageFunding';

export { RetypeAborted };

const TARGET_TYPE = 'transfer';
const TARGET_CATEGORY = 'Transfer';

/** Revision sources that mean a person chose the row's current values. */
const USER_REVISION_SOURCES: readonly TransactionRevisionSource[] = [
  'user_edit',
  'bulk_patch',
  'ai_suggestion',
  'restore',
];

type Row = RetypeCandidate & { finalCategory: string | null };

/** True when the detector's Find & Save rule claims this narrative. */
export function isFindAndSaveSweep(row: RetypeCandidate): boolean {
  if (!FIND_AND_SAVE_RE.test(`${row.merchantRaw} ${row.merchantClean}`)) return false;
  return confidentNarrativeType(row) === TARGET_TYPE;
}

/** A Find & Save row whose type or category is not yet transfer / Transfer. */
export function needsFindAndSaveFix(row: Row): boolean {
  if (!isFindAndSaveSweep(row)) return false;
  return row.txnType !== TARGET_TYPE || row.finalCategory !== TARGET_CATEGORY;
}

export type SkipReason = 'reviewed' | 'category_override' | 'user_edited';

export interface FindAndSaveRow {
  id: number;
  accountId: number | null;
  date: string;
  amount: string;
  merchantRaw: string;
  fromType: string;
  fromCategory: string | null;
}

export interface FindAndSaveScan {
  /** Type changes to transfer (and category to Transfer). */
  retype: FindAndSaveRow[];
  /** Already transfer; only the category changes to Transfer. */
  recategorise: FindAndSaveRow[];
  /** Would change, but a person touched the row. Never written. */
  skipped: Array<FindAndSaveRow & { reasons: SkipReason[] }>;
}

function str(v: unknown, fallback = ''): string {
  return v == null ? fallback : String(v);
}

function toRow(t: Transaction): Row {
  const merchantRaw = str(t.merchantRaw);
  return {
    merchantRaw,
    merchantClean: str(t.merchantClean, merchantRaw),
    amount: Number(t.amount),
    txnType: t.txnType,
    finalCategory: t.finalCategory ?? null,
  };
}

function toReport(t: Transaction): FindAndSaveRow {
  return {
    id: t.id,
    accountId: t.accountId ?? null,
    date: str(t.date).slice(0, 10),
    amount: str(t.amount),
    merchantRaw: str(t.merchantRaw),
    fromType: str(t.txnType, 'null'),
    fromCategory: t.finalCategory ?? null,
  };
}

function skipReasons(t: Transaction, userEdited: Set<number>): SkipReason[] {
  const checks: Array<[SkipReason, boolean]> = [
    ['reviewed', t.reviewedAt != null],
    ['category_override', Boolean(t.categoryOverride)],
    ['user_edited', userEdited.has(t.id)],
  ];
  return checks.filter(([, hit]) => hit).map(([reason]) => reason);
}

async function userEditedIds(ids: number[], t?: DbTransaction): Promise<Set<number>> {
  if (ids.length === 0) return new Set();
  const revisions = await TransactionRevision.findAll({
    attributes: ['transactionId'],
    where: { transactionId: ids, source: { [Op.in]: USER_REVISION_SOURCES as string[] } },
    transaction: t,
  });
  return new Set(revisions.map((r) => r.transactionId));
}

export async function scanFindAndSave(t?: DbTransaction): Promise<FindAndSaveScan> {
  // Coarse, dialect-neutral prefilter; the detector makes the actual call.
  const rows = await Transaction.findAll({
    where: where(fn('lower', col('merchant_raw')), { [Op.like]: '%find%save%' }),
    order: [['id', 'ASC']],
    transaction: t,
  });
  const candidates = rows.filter((r) => needsFindAndSaveFix(toRow(r)));
  const userEdited = await userEditedIds(candidates.map((r) => r.id), t);

  const scan: FindAndSaveScan = { retype: [], recategorise: [], skipped: [] };
  for (const r of candidates) {
    const reasons = skipReasons(r, userEdited);
    if (reasons.length > 0) scan.skipped.push({ ...toReport(r), reasons });
    else if (r.txnType !== TARGET_TYPE) scan.retype.push(toReport(r));
    else scan.recategorise.push(toReport(r));
  }
  return scan;
}

/** Signed total of the re-typed spend rows by calendar year (what leaves the spend figures). */
export function spendImpactByYear(rows: FindAndSaveRow[]): Array<{ year: string; count: number; total: number }> {
  const byYear = new Map<string, { count: number; total: number }>();
  for (const r of rows) {
    if (r.fromType !== 'purchase') continue;
    const year = r.date.slice(0, 4);
    const y = byYear.get(year) ?? { count: 0, total: 0 };
    y.count += 1;
    y.total = Math.round((y.total + Number(r.amount)) * 100) / 100;
    byYear.set(year, y);
  }
  return [...byYear].sort(([a], [b]) => a.localeCompare(b)).map(([year, y]) => ({ year, ...y }));
}

/**
 * Write every writable candidate in one SQL transaction. The scan runs again
 * inside the transaction so the write acts on what is true at commit time; if
 * the writable count is not exactly `expect`, or any writable candidate remains
 * after the writes, nothing is committed.
 */
export async function applyFindAndSaveRetype(opts: { expect: number }): Promise<{ written: number }> {
  return sequelize.transaction(async (t) => {
    const scan = await scanFindAndSave(t);
    const writable = [...scan.retype, ...scan.recategorise];
    if (writable.length !== opts.expect) {
      throw new RetypeAborted(`expected ${opts.expect} row(s), found ${writable.length}; nothing written`);
    }
    for (const r of writable) await writeRow(r.id, t);
    const after = await scanFindAndSave(t);
    const left = after.retype.length + after.recategorise.length;
    if (left !== 0) {
      throw new RetypeAborted(`${left} row(s) still need the fix after the writes; rolled back`);
    }
    return { written: writable.length };
  });
}

/** Lock the row, confirm it is still writable, and save it (one revision). */
async function writeRow(id: number, t: DbTransaction): Promise<void> {
  const row = await Transaction.findByPk(id, { transaction: t, lock: t.LOCK.UPDATE });
  if (row == null || !(await stillWritable(row, t))) {
    throw new RetypeAborted(`transaction ${id} changed under the re-type; nothing written`);
  }
  // What the enrichment pipeline now derives for this narrative: a
  // high-confidence, non-AI category, which also clears review.
  row.set({
    txnType: TARGET_TYPE,
    autoCategory: TARGET_CATEGORY,
    autoSource: 'type-detect',
    autoConfidence: 'high',
    reviewFlag: false,
  });
  recomputeTransactionAmounts(row);
  await row.save({ transaction: t });
}

async function stillWritable(row: Transaction, t: DbTransaction): Promise<boolean> {
  if (!needsFindAndSaveFix(toRow(row))) return false;
  return skipReasons(row, await userEditedIds([row.id], t)).length === 0;
}
