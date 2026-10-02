/**
 * Whether a transaction's existing `linked_transaction_id` is established, and so
 * must not be replaced or cleared by an automatic re-link (the enrichment
 * backfill, a re-import).
 *
 * Established means any of:
 *   - reciprocal: the partner points back, so the pair is whole;
 *   - set by a person: `POST /api/transfers/link` (and import commit) stamp
 *     `transfer_linked_at`;
 *   - on a reviewed row: the user has accepted the row as it stands, link
 *     included (a manual refund link stamps `reviewed_at`).
 *
 * Without this the backfill wrote whatever the matcher returned on every run —
 * prod txn 992 flipped 2895 → 2954 → 2895 across reruns.
 */
export function isEstablishedLink(
  row: {
    linkedTransactionId: number | null;
    transferLinkedAt: Date | null;
    reviewedAt: Date | null;
  },
  partnerLinksBack: boolean,
): boolean {
  if (row.linkedTransactionId == null) return false;
  return partnerLinksBack || row.transferLinkedAt != null || row.reviewedAt != null;
}
