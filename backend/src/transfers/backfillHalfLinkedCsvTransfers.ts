/**
 * One-off repair: close the half-linked transfer pairs whose forward leg was
 * written by the CSV importer (`runImport.importCsvFile`).
 *
 * A half-link is a transfer/payment row A with `linked_transaction_id = B` while
 * B's own `linked_transaction_id` is NULL. Both legs sit in the Transfers
 * unmatched queue, and because neither is "established" (see linkProtection.ts)
 * the nightly enrichment matcher keeps rewriting them. The repair writes what
 * the shared import builder (importedTransaction.ts) now writes at insert time:
 *   - B.linked_transaction_id = A.id and B.transfer_linked_at = now
 *   - A.transfer_linked_at = now when it is missing
 *   - B.txn_type = 'transfer' only when B's type was a classifier guess
 *
 * Scope is deliberately narrow. Pairs written by the statement path were linked
 * both ways at insert, then partly cleared by the nightly job on purpose, so
 * restoring them is a judgement call this script does not make. Which importer
 * wrote a row is not stored on it: `import_batch` labels collide between PDF and
 * CSV imports of the same account in the same month. So each row is pinned to the
 * import whose run window contains the row's `created_at`, and only rows whose
 * import was a direct `.csv` upload qualify.
 *
 * Every write is an instance save, so each touched row gets a TransactionRevision.
 */
import { Op } from 'sequelize';
import type { Transaction as DbTransaction } from 'sequelize';
import { ImportHistory, Transaction, sequelize } from '../models';
import { GUESSED_TXN_TYPES } from '../import/importedTransaction';

export type ImportSourceKind =
  | 'csv_direct'
  | 'csv_wsbundle'
  | 'pdf'
  | 'simplefin'
  | 'other'
  | 'unmatched';

type HistoryWindow = Pick<ImportHistory, 'fileName' | 'profileId' | 'startedAt' | 'finishedAt'>;

/** Wealthsimple bundle CSVs go through commitStatementImport, not importCsvFile. */
const WS_BUNDLE_SINCE = new Date('2026-05-23T00:00:00Z');
const WINDOW_SLACK_MS = 2000;

export function classifyImportSource(h: HistoryWindow | null): ImportSourceKind {
  if (h == null) return 'unmatched';
  if (h.profileId === 'simplefin') return 'simplefin';
  const name = h.fileName.toLowerCase();
  if (name.endsWith('.csv')) {
    return name.includes('statement-transactions') && h.startedAt >= WS_BUNDLE_SINCE
      ? 'csv_wsbundle'
      : 'csv_direct';
  }
  if (name.endsWith('.pdf')) return 'pdf';
  return 'other';
}

/**
 * The import run that wrote a row: the one whose [startedAt, finishedAt] window
 * (with a little slack) contains the row's createdAt, else the nearest start.
 */
export function pickImportHistory<H extends HistoryWindow>(createdAt: Date, histories: H[]): H | null {
  const at = createdAt.getTime();
  const inWindow = (h: H) => {
    const start = h.startedAt.getTime() - WINDOW_SLACK_MS;
    const end = (h.finishedAt ?? h.startedAt).getTime() + WINDOW_SLACK_MS;
    return at >= start && at <= end;
  };
  const distance = (h: H) => Math.abs(at - h.startedAt.getTime());
  const ranked = [...histories].sort(
    (a, b) => Number(inWindow(b)) - Number(inWindow(a)) || distance(a) - distance(b),
  );
  return ranked[0] ?? null;
}

export interface HalfLinkedPair {
  householdId: number | null;
  /** The forward leg, written by the CSV importer. */
  aId: number;
  /** The leg A points at, which does not point back. */
  bId: number;
  aNeedsStamp: boolean;
  /** B's type is a classifier guess and becomes 'transfer'. */
  bRetype: boolean;
}

export type SkipReason =
  | 'sibling_missing'
  | 'sibling_claimed_twice'
  | 'same_account'
  | 'cross_household'
  | 'amount_mismatch'
  | 'not_csv_direct';

export interface HalfLinkScan {
  pairs: HalfLinkedPair[];
  skipped: Record<SkipReason, number>;
}

const TRANSFER_TYPES = ['transfer', 'payment'];

/** Exactly opposite amounts, like the transfer matcher requires. */
export function oppositeAmounts(a: string, b: string): boolean {
  const x = Number(a);
  const y = Number(b);
  return Math.sign(x) === -Math.sign(y) && Math.abs(Math.abs(x) - Math.abs(y)) <= 0.01;
}

/** Why a direct-CSV half-link cannot be closed mechanically, or null when it can. */
function skipReason(
  a: Transaction,
  b: Transaction | undefined,
  claims: Map<number, number>,
): SkipReason | null {
  if (b == null) return 'sibling_missing';
  if ((claims.get(b.id) ?? 0) > 1) return 'sibling_claimed_twice';
  if (a.accountId === b.accountId) return 'same_account';
  if (a.householdId !== b.householdId) return 'cross_household';
  if (!oppositeAmounts(a.amount, b.amount)) return 'amount_mismatch';
  return null;
}

export async function scanHalfLinkedCsvTransfers(t?: DbTransaction): Promise<HalfLinkScan> {
  const skipped: Record<SkipReason, number> = {
    sibling_missing: 0,
    sibling_claimed_twice: 0,
    same_account: 0,
    cross_household: 0,
    amount_mismatch: 0,
    not_csv_direct: 0,
  };
  const forward = await Transaction.findAll({
    where: { linkedTransactionId: { [Op.ne]: null }, txnType: { [Op.in]: TRANSFER_TYPES } },
    order: [['id', 'ASC']],
    transaction: t,
  });
  const siblingIds = [...new Set(forward.map((a) => a.linkedTransactionId as number))];
  const siblings = new Map(
    (await Transaction.findAll({ where: { id: siblingIds }, transaction: t })).map((b) => [b.id, b]),
  );
  // How many rows point at each sibling. A sibling claimed by two rows has no
  // single right answer for its reverse pointer.
  const claims = new Map<number, number>();
  for (const r of await Transaction.findAll({
    attributes: ['linkedTransactionId'],
    where: { linkedTransactionId: siblingIds },
    transaction: t,
  })) {
    const id = r.linkedTransactionId as number;
    claims.set(id, (claims.get(id) ?? 0) + 1);
  }

  // B does not point back. A B that points at a third row is a different
  // problem (a contested link), not a half-link.
  const halfLinked = forward.filter(
    (a) => siblings.get(a.linkedTransactionId as number)?.linkedTransactionId == null,
  );

  const batches = [...new Set(halfLinked.map((a) => a.importBatch))];
  const historiesByBatch = new Map<string, ImportHistory[]>();
  for (const h of await ImportHistory.findAll({ where: { batchLabel: batches }, transaction: t })) {
    const list = historiesByBatch.get(h.batchLabel) ?? [];
    list.push(h);
    historiesByBatch.set(h.batchLabel, list);
  }

  const pairs: HalfLinkedPair[] = [];
  for (const a of halfLinked) {
    const history = pickImportHistory(a.createdAt, historiesByBatch.get(a.importBatch) ?? []);
    if (classifyImportSource(history) !== 'csv_direct') {
      skipped.not_csv_direct += 1;
      continue;
    }
    const b = siblings.get(a.linkedTransactionId as number);
    const reason = skipReason(a, b, claims);
    if (reason != null || b == null) {
      skipped[reason ?? 'sibling_missing'] += 1;
      continue;
    }
    pairs.push({
      householdId: a.householdId,
      aId: a.id,
      bId: b.id,
      aNeedsStamp: a.transferLinkedAt == null,
      bRetype: GUESSED_TXN_TYPES.includes(b.txnType),
    });
  }
  return { pairs, skipped };
}

export interface HouseholdSummary {
  householdId: number | null;
  pairs: number;
  aStamped: number;
  bRetyped: number;
  examples: Array<[number, number]>;
}

export function summarizeByHousehold(pairs: HalfLinkedPair[], exampleCount = 5): HouseholdSummary[] {
  const byHousehold = new Map<number | null, HouseholdSummary>();
  for (const p of pairs) {
    const s = byHousehold.get(p.householdId) ?? {
      householdId: p.householdId,
      pairs: 0,
      aStamped: 0,
      bRetyped: 0,
      examples: [],
    };
    s.pairs += 1;
    if (p.aNeedsStamp) s.aStamped += 1;
    if (p.bRetype) s.bRetyped += 1;
    if (s.examples.length < exampleCount) s.examples.push([p.aId, p.bId]);
    byHousehold.set(p.householdId, s);
  }
  return [...byHousehold.values()].sort((x, y) => (x.householdId ?? -1) - (y.householdId ?? -1));
}

export class BackfillAborted extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackfillAborted';
  }
}

/**
 * Write each pair's missing half: B points back at A and is stamped, A is stamped
 * if it was not, and a guessed B type becomes transfer. Instance saves, so each
 * touched row gets a TransactionRevision. Throws (rolling the caller's
 * transaction back) if a sibling was linked by someone else in the meantime.
 */
export async function closeHalfLinkedPairs(
  pairs: HalfLinkedPair[],
  now: Date,
  t: DbTransaction,
): Promise<void> {
  for (const p of pairs) {
    const b = await Transaction.findByPk(p.bId, { transaction: t, lock: t.LOCK.UPDATE });
    if (b == null || b.linkedTransactionId != null) {
      throw new BackfillAborted(`sibling ${p.bId} changed under the backfill; nothing written`);
    }
    b.set({ linkedTransactionId: p.aId, transferLinkedAt: now });
    if (p.bRetype) b.set({ txnType: 'transfer' });
    await b.save({ transaction: t });
    if (p.aNeedsStamp) {
      const a = await Transaction.findByPk(p.aId, { transaction: t, lock: t.LOCK.UPDATE });
      a!.set({ transferLinkedAt: now });
      await a!.save({ transaction: t });
    }
  }
}

/**
 * Close every pair in one SQL transaction. The scan runs again inside the
 * transaction (with the siblings row-locked) so the write acts on what is true at
 * commit time, not at dry-run time; if that differs from `expectPairs`, or any
 * pair is still open after the writes, nothing is committed.
 */
export async function applyHalfLinkedCsvTransferBackfill(
  opts: { expectPairs?: number | null; now?: Date } = {},
): Promise<{ fixed: number }> {
  return sequelize.transaction(async (t) => {
    const { pairs } = await scanHalfLinkedCsvTransfers(t);
    if (opts.expectPairs != null && pairs.length !== opts.expectPairs) {
      throw new BackfillAborted(`expected ${opts.expectPairs} pair(s), found ${pairs.length}; nothing written`);
    }
    await closeHalfLinkedPairs(pairs, opts.now ?? new Date(), t);
    const after = await scanHalfLinkedCsvTransfers(t);
    if (after.pairs.length !== 0) {
      throw new BackfillAborted(`${after.pairs.length} pair(s) still half-linked after the writes; rolled back`);
    }
    return { fixed: pairs.length };
  });
}
