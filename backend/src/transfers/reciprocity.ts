/**
 * Transfer link reciprocity logic (issue #553).
 *
 * A transfer is modelled as two transaction legs that point at each other
 * via `linked_transaction_id`: leg A.linked = B AND leg B.linked = A. The
 * link is written atomically by `POST /api/transfers/link`, but historical
 * data, partial imports, and aborted writes can leave **one-way** links —
 * A points at B, but B points at something else (or nothing). Those are
 * NOT real matches and must not inflate the "matched" stat, nor be silently
 * dropped from money-movement totals.
 *
 * This module centralises the reciprocity check so `/stats` and
 * `/money-movement` agree on what counts as a matched pair, and so the logic
 * is unit-testable without a database.
 *
 * Definitions:
 *   - **Reciprocal pair**: legs A and B where A.linked = B.id and
 *     B.linked = A.id. Counts once.
 *   - **Dangling leg**: a leg with linked_transaction_id set, whose target
 *     either is absent from the working set or does not link back. One-way.
 *   - **Unmatched leg**: a leg with no link at all (linked_transaction_id
 *     IS NULL).
 */

export type ReciprocityLeg = {
  id: number;
  linkedTransactionId: number | null;
  transferPurpose: string | null;
};

export type ReciprocitySummary = {
  /** Count of reciprocal pairs (each pair counted once, not per leg). */
  matched: number;
  /** Count of legs with no link at all. */
  unmatched: number;
  /** Count of legs whose link is one-way / broken (not reciprocal). */
  dangling: number;
  /** Reciprocal-pair count keyed by purpose (one entry per pair). */
  byPurpose: Record<string, number>;
};

/**
 * True iff `leg` participates in a reciprocal pair within `byId`.
 */
function isReciprocal(leg: ReciprocityLeg, byId: Map<number, ReciprocityLeg>): boolean {
  if (leg.linkedTransactionId == null) return false;
  const sibling = byId.get(leg.linkedTransactionId);
  return sibling != null && sibling.linkedTransactionId === leg.id;
}

/**
 * Classify a set of transfer legs into matched (reciprocal pairs),
 * unmatched (no link), and dangling (one-way/broken link) buckets.
 */
export function summarizeReciprocity(legs: ReciprocityLeg[]): ReciprocitySummary {
  const byId = new Map<number, ReciprocityLeg>();
  for (const leg of legs) byId.set(leg.id, leg);

  let matchedLegs = 0;
  let unmatched = 0;
  let dangling = 0;
  const byPurposeLegs: Record<string, number> = {};

  for (const leg of legs) {
    if (leg.linkedTransactionId == null) {
      unmatched += 1;
      continue;
    }
    if (isReciprocal(leg, byId)) {
      matchedLegs += 1;
      const key = leg.transferPurpose ?? 'unclassified';
      byPurposeLegs[key] = (byPurposeLegs[key] ?? 0) + 1;
    } else {
      dangling += 1;
    }
  }

  // Each reciprocal pair contributes two matched legs; collapse to pairs.
  const byPurpose: Record<string, number> = {};
  for (const [key, n] of Object.entries(byPurposeLegs)) byPurpose[key] = Math.round(n / 2);

  return {
    matched: Math.round(matchedLegs / 2),
    unmatched,
    dangling,
    byPurpose,
  };
}

export type MovementRow = {
  id: number;
  accountId: number;
  accountName: string;
  amount: number;
  currency: string;
  linkedTransactionId: number | null;
  transferPurpose: string | null;
};

export type MovementFlow = {
  sourceAccountId: number;
  sourceAccountName: string;
  destAccountId: number;
  destAccountName: string;
  sourceCurrency: string;
  destCurrency: string;
  purpose: string | null;
  totalSourceAmount: number;
  totalDestAmount: number;
  count: number;
};

export type MovementDangling = {
  /** Number of one-way / broken legs that could not be paired. */
  count: number;
  /** Sum of |amount| of the dangling legs (so the value is not lost). */
  totalSourceAmount: number;
};

export type MovementAggregate = {
  flows: MovementFlow[];
  dangling: MovementDangling;
};

/**
 * Aggregate linked transfer legs into money-movement flows. Only reciprocal
 * pairs contribute to `flows`; legs whose link is one-way or broken are
 * surfaced in `dangling` (count + summed absolute value) rather than being
 * silently discarded — that silent drop was the ~$185k leak in issue #553.
 */
export function aggregateMoneyMovement(
  rows: MovementRow[],
  /**
   * Optional extra legs used only to resolve reciprocity (e.g. a sibling
   * that falls outside the requested date window). They are NOT iterated as
   * anchors, so they never produce their own flow or dangling entry — they
   * only let an in-window leg find its reciprocating partner. When omitted,
   * reciprocity is resolved from `rows` alone.
   */
  siblingLookup?: Iterable<MovementRow>,
): MovementAggregate {
  const byId = new Map<number, MovementRow>();
  if (siblingLookup) {
    for (const r of siblingLookup) byId.set(r.id, r);
  }
  // Anchors take precedence in the map so their fields win on overlap.
  for (const r of rows) byId.set(r.id, r);

  const flowsByGroup = new Map<string, MovementFlow>();
  const seenPair = new Set<string>();
  const dangling: MovementDangling = { count: 0, totalSourceAmount: 0 };

  for (const r of rows) {
    const linkedId = r.linkedTransactionId;
    if (linkedId == null) {
      // Should not appear here (callers filter to linked rows), but treat a
      // null link as nothing to aggregate.
      continue;
    }
    const sibling = byId.get(linkedId);
    const reciprocal = sibling != null && sibling.linkedTransactionId === r.id;
    if (!reciprocal) {
      // One-way / broken link. Count it once (on its own leg) and keep its
      // value visible. Both halves of a broken pair get counted because each
      // is independently non-reciprocal — that is the honest tally of legs
      // that did not pair.
      dangling.count += 1;
      dangling.totalSourceAmount += Math.abs(Number(r.amount));
      continue;
    }

    const pairKey = r.id < linkedId ? `${r.id}-${linkedId}` : `${linkedId}-${r.id}`;
    if (seenPair.has(pairKey)) continue;
    seenPair.add(pairKey);

    // Source is the negative leg, destination the positive leg. Ties treat
    // `r` as source.
    const rAmt = Number(r.amount);
    const sAmt = Number(sibling.amount);
    const source = rAmt <= sAmt ? r : sibling;
    const dest = source === r ? sibling : r;
    const sourceAmount = Math.abs(Number(source.amount));
    const destAmount = Math.abs(Number(dest.amount));

    const groupKey = `${source.accountId}-${dest.accountId}-${source.currency}-${dest.currency}-${r.transferPurpose ?? ''}`;
    const acc = flowsByGroup.get(groupKey);
    if (acc) {
      acc.totalSourceAmount += sourceAmount;
      acc.totalDestAmount += destAmount;
      acc.count += 1;
    } else {
      flowsByGroup.set(groupKey, {
        sourceAccountId: source.accountId,
        sourceAccountName: source.accountName,
        destAccountId: dest.accountId,
        destAccountName: dest.accountName,
        sourceCurrency: source.currency,
        destCurrency: dest.currency,
        purpose: r.transferPurpose ?? null,
        totalSourceAmount: sourceAmount,
        totalDestAmount: destAmount,
        count: 1,
      });
    }
  }

  const flows = Array.from(flowsByGroup.values()).sort(
    (a, b) => b.totalSourceAmount - a.totalSourceAmount,
  );

  return { flows, dangling };
}
