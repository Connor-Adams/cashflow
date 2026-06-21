import { MATCH_CONFIDENCE_THRESHOLD } from './matcher';

/**
 * Identifies the spurious many-to-one accepted TransactionOrderLinks produced by
 * the historical Amazon-matcher fan-out (see {@link selectMatchCandidates}).
 *
 * A link is targeted when it is `accepted`, scores below
 * {@link MATCH_CONFIDENCE_THRESHOLD}, and belongs to a transaction that carries
 * two or more accepted links. Confident links (>= threshold) and lone (1:1)
 * sub-threshold links are left untouched — the latter are reported for
 * visibility but are out of scope for this cleanup.
 */
export type AcceptedLinkRow = {
  id: number;
  transactionId: number;
  /** Sequelize delivers DECIMAL columns as strings; accept either. */
  confidence: number | string;
  status?: string;
};

export type FanoutClusterSummary = {
  transactionId: number;
  /** Accepted links on this transaction. */
  total: number;
  /** Sub-threshold accepted links (the ones to reject). */
  subThreshold: number;
  /** Accepted links at/above threshold (kept). */
  keptStrong: number;
};

export type FanoutCleanupPlan = {
  /** Link ids to demote from `accepted` to `rejected`. */
  rejectIds: number[];
  affectedTransactionIds: number[];
  manyToOneClusters: FanoutClusterSummary[];
  /** Count of lone (1:1) sub-threshold accepted links — reported, not touched. */
  loneSubThreshold: number;
};

const toConfidence = (value: number | string): number => Number(value);

export function planFanoutCleanup(links: AcceptedLinkRow[]): FanoutCleanupPlan {
  const accepted = links.filter((link) => (link.status ?? 'accepted') === 'accepted');

  const byTransaction = new Map<number, AcceptedLinkRow[]>();
  for (const link of accepted) {
    const group = byTransaction.get(link.transactionId) ?? [];
    group.push(link);
    byTransaction.set(link.transactionId, group);
  }

  const rejectIds: number[] = [];
  const affected = new Set<number>();
  const clusters: FanoutClusterSummary[] = [];
  let loneSubThreshold = 0;

  for (const [transactionId, group] of byTransaction) {
    const subThreshold = group.filter(
      (link) => toConfidence(link.confidence) < MATCH_CONFIDENCE_THRESHOLD,
    );

    if (group.length < 2) {
      // 1:1 accepted link — not a many-to-one fan-out, leave it but report it.
      loneSubThreshold += subThreshold.length;
      continue;
    }
    if (subThreshold.length === 0) continue; // all confident (e.g. a real split) — keep

    for (const link of subThreshold) rejectIds.push(link.id);
    affected.add(transactionId);
    clusters.push({
      transactionId,
      total: group.length,
      subThreshold: subThreshold.length,
      keptStrong: group.length - subThreshold.length,
    });
  }

  return {
    rejectIds: rejectIds.sort((a, b) => a - b),
    affectedTransactionIds: [...affected].sort((a, b) => a - b),
    manyToOneClusters: clusters.sort(
      (a, b) => b.subThreshold - a.subThreshold || a.transactionId - b.transactionId,
    ),
    loneSubThreshold,
  };
}
