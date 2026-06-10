/**
 * Shared "current position" derivation over HoldingSnapshot rows, extracted
 * from networth/portfolioMarketValueAt.ts (PR #604) so the Portfolio page
 * (routes/portfolio.ts loadVisibleLatestHoldings) and net worth apply the
 * exact same fully-sold inference and never disagree.
 */

export type SnapshotPositionKey = {
  accountId: number;
  securityId: number;
  /** DATEONLY string (YYYY-MM-DD) — compared lexically. */
  statementDate: string;
};

/**
 * Reduce HoldingSnapshot-like rows to the current position per
 * (accountId, securityId) pair.
 *
 * PRECONDITION: rows must be sorted statementDate DESC with an id DESC
 * tiebreaker (the order both call sites already query with) — the first row
 * seen per pair wins, so same-day duplicate snapshots (corrected re-imports)
 * resolve deterministically to the newest row.
 *
 * A pair whose own latest snapshot predates the account's newest statement
 * in the input was absent from that statement — i.e. fully sold — and is
 * dropped instead of carrying its last pre-sale value forward forever.
 * Imports write no zero-quantity tombstones, so absence is the only sale
 * signal we have. The newest-statement date is tracked per account, so a
 * newer statement on one account never zeroes another account's positions.
 */
export function latestActivePositions<T extends SnapshotPositionKey>(rows: T[]): T[] {
  const accountLatestDate = new Map<number, string>();
  const latest = new Map<string, T>();
  for (const row of rows) {
    if (!accountLatestDate.has(row.accountId)) {
      accountLatestDate.set(row.accountId, row.statementDate);
    }
    const key = `${row.accountId}:${row.securityId}`;
    if (!latest.has(key)) latest.set(key, row);
  }
  const out: T[] = [];
  for (const row of latest.values()) {
    const accountLatest = accountLatestDate.get(row.accountId);
    if (accountLatest != null && row.statementDate < accountLatest) continue;
    out.push(row);
  }
  return out;
}
