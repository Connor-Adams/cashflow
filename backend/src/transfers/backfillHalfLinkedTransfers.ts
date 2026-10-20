/**
 * Classify every remaining half-linked transfer pair and close the classes a
 * person chose. Successor to backfillHalfLinkedCsvTransfers.ts, which was scoped to
 * direct-CSV pairs; this covers every importer.
 *
 * A half-link is a transfer/payment row A with `linked_transaction_id = B` while
 * B's own pointer is NULL. Each one lands in exactly one class:
 *
 *   ambiguous       closing it needs a person: B is missing, claimed by more than
 *                   one row (usually a duplicate import), on A's account, in
 *                   another household, not the exact opposite amount, reviewed by
 *                   a person as it stands, or typed something a transfer
 *                   contradicts (income, refund, ...).
 *   cleared_by_job  B used to point at A, and a `system` revision (an older
 *                   enrichment backfill, before the established-link guard) set
 *                   it back to NULL. The pair was whole once.
 *   safe            everything else: B never pointed anywhere.
 *
 * Closing a pair writes what the import builder writes at insert time (see
 * closeHalfLinkedPairs). Nothing is closed unless its class is asked for.
 */
import { Op } from 'sequelize';
import type { Transaction as DbTransaction } from 'sequelize';
import { Transaction, TransactionRevision } from '../models';
import { GUESSED_TXN_TYPES } from '../import/importedTransaction';
import {
  closeInOneTransaction,
  loadHalfLinks,
  skipReason,
  type GuardReason,
  type HalfLinkedPair,
} from './backfillHalfLinkedCsvTransfers';

export type HalfLinkClass = 'safe' | 'cleared_by_job' | 'ambiguous';

export type AmbiguousReason = GuardReason | 'sibling_reviewed' | 'sibling_type_conflict';

export interface ClassifiedHalfLink extends HalfLinkedPair {
  cls: HalfLinkClass;
  reason: AmbiguousReason | null;
  /** B's type now. */
  bType: string | null;
}

/** Types a linked transfer leg may carry; anything else contradicts the link. */
const LINKABLE_TYPES = ['transfer', 'payment', ...GUESSED_TXN_TYPES];

type Change = { field: string; before: unknown; after: unknown };

function parseChanges(raw: string): Change[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as Change[]) : [];
  } catch {
    return [];
  }
}

/** B ids whose pointer at A was cleared by a `system` revision. */
async function siblingsClearedByJob(
  pairs: Array<{ aId: number; bId: number }>,
  t?: DbTransaction,
): Promise<Set<number>> {
  const aOf = new Map(pairs.map((p) => [p.bId, p.aId]));
  const revisions = await TransactionRevision.findAll({
    where: { transactionId: { [Op.in]: [...aOf.keys()] }, source: 'system' },
    transaction: t,
  });
  const cleared = new Set<number>();
  for (const r of revisions) {
    const pointedAtA = parseChanges(r.changes).some(
      (c) => c.field === 'linkedTransactionId' && c.after == null && Number(c.before) === aOf.get(r.transactionId),
    );
    if (pointedAtA) cleared.add(r.transactionId);
  }
  return cleared;
}

function ambiguousReason(
  a: Transaction,
  b: Transaction | undefined,
  claims: Map<number, number>,
): AmbiguousReason | null {
  const mechanical = skipReason(a, b, claims);
  if (mechanical != null || b == null) return mechanical ?? 'sibling_missing';
  if (b.reviewedAt != null) return 'sibling_reviewed';
  if (!LINKABLE_TYPES.includes(b.txnType)) return 'sibling_type_conflict';
  return null;
}

export async function classifyHalfLinkedTransfers(t?: DbTransaction): Promise<ClassifiedHalfLink[]> {
  const { halfLinked, siblings, claims } = await loadHalfLinks(t);
  const cleared = await siblingsClearedByJob(
    halfLinked.map((a) => ({ aId: a.id, bId: a.linkedTransactionId as number })),
    t,
  );

  return halfLinked.map((a) => {
    const bId = a.linkedTransactionId as number;
    const b = siblings.get(bId);
    const reason = ambiguousReason(a, b, claims);
    const cls: HalfLinkClass = reason != null ? 'ambiguous' : cleared.has(bId) ? 'cleared_by_job' : 'safe';
    return {
      householdId: a.householdId,
      aId: a.id,
      bId,
      aNeedsStamp: a.transferLinkedAt == null,
      bRetype: b != null && GUESSED_TXN_TYPES.includes(b.txnType),
      cls,
      reason,
      bType: b?.txnType ?? null,
    };
  });
}

export interface ClassSummary {
  cls: HalfLinkClass;
  pairs: number;
  aStamped: number;
  bRetyped: number;
  /** B's current type → count. */
  bTypes: Record<string, number>;
  /** Ambiguous only: reason → count. */
  reasons: Partial<Record<AmbiguousReason, number>>;
  examples: Array<[number, number]>;
}

export function summarizeByClass(rows: ClassifiedHalfLink[], exampleCount = 5): ClassSummary[] {
  const order: HalfLinkClass[] = ['safe', 'cleared_by_job', 'ambiguous'];
  return order.map((cls) => {
    const inClass = rows.filter((r) => r.cls === cls);
    const s: ClassSummary = {
      cls,
      pairs: inClass.length,
      aStamped: inClass.filter((r) => r.aNeedsStamp).length,
      bRetyped: inClass.filter((r) => r.bRetype).length,
      bTypes: {},
      reasons: {},
      examples: inClass.slice(0, exampleCount).map((r) => [r.aId, r.bId]),
    };
    for (const r of inClass) {
      const type = r.bType ?? 'missing';
      s.bTypes[type] = (s.bTypes[type] ?? 0) + 1;
      if (r.reason) s.reasons[r.reason] = (s.reasons[r.reason] ?? 0) + 1;
    }
    return s;
  });
}

/**
 * Close every pair in `classes`, in one SQL transaction. The classification runs
 * again inside it; if the count differs from `expectPairs`, or any chosen pair is
 * still open after the writes, nothing is committed. `ambiguous` is never
 * closable here.
 */
export async function applyHalfLinkedTransferBackfill(opts: {
  classes: Array<Exclude<HalfLinkClass, 'ambiguous'>>;
  expectPairs?: number | null;
  now?: Date;
}): Promise<{ fixed: number }> {
  const chosen = (rows: ClassifiedHalfLink[]) =>
    rows.filter((r) => (opts.classes as HalfLinkClass[]).includes(r.cls));
  return closeInOneTransaction(async (t) => chosen(await classifyHalfLinkedTransfers(t)), opts);
}
