/**
 * Filter rows by currency (or pass-through when currency is empty) and
 * sort by net spend desc, breaking ties on transaction count desc.
 *
 * Shared between DashboardPage (merchant + account rollups for the
 * bento table-tiles) and ReportsPage (Merchants + Accounts sections).
 */
export function rankByNetSpend<
  T extends { currency: string; netSpend: number; transactionCount: number },
>(rows: T[], currency: string): T[] {
  return rows
    .filter((row) => !currency || row.currency === currency)
    .slice()
    .sort((a, b) =>
      b.netSpend === a.netSpend
        ? b.transactionCount - a.transactionCount
        : b.netSpend - a.netSpend
    )
}
