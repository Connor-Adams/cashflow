import { num } from '../util/numbers';
import { classifyPositiveAmount, isNonCategorical } from './classifyTransactionFlow';

/**
 * Transaction row shape consumed by the monthly aggregator. Mirrors the
 * `Transaction.findAll` attribute list in the GET /api/summary/monthly
 * route — kept here (rather than in a shared types file) so the route can
 * tell at a glance which fields the aggregator actually reads.
 */
export type MonthlyTxnRow = {
  accountId: number;
  date: string;
  currency: string;
  merchantRaw: string | null;
  merchantClean: string | null;
  finalCategory: string | null;
  amount: unknown;
  txnType: string | null;
};

/**
 * Aggregator for the /api/summary/monthly endpoint. Sums signed `amount`
 * per (month, currency) into a single "activity" curve.
 *
 * Excluded:
 *  - statement payments (positive amount with txnType resolving to 'payment'
 *    via `classifyPositiveAmount` — not category data, would inflate)
 *  - non-categorical money movement (transfer / investment / dividend, plus
 *    anything on an investment account — see `classifyTransactionFlow`)
 *
 * Included:
 *  - refunds / rewards / income — they net against the same month's spend
 *    in the UI, which is what users expect
 *  - rows whose `num()` parse fails are silently skipped (legacy data)
 *
 * Sorting is left to the route so this stays a pure data transform.
 */
export function aggregateMonthly(
  rows: MonthlyTxnRow[],
  accountTypeById: Map<number, string | null>,
): Array<{ month: string; currency: string; sumAmount: number }> {
  const points = new Map<string, { month: string; currency: string; sumAmount: number }>();
  for (const row of rows) {
    const amount = num(row.amount);
    if (amount == null) continue;
    const accountType = accountTypeById.get(row.accountId);
    if (
      amount > 0 &&
      classifyPositiveAmount({
        txnType: row.txnType,
        accountType,
        merchantRaw: row.merchantRaw,
        merchantClean: row.merchantClean,
        category: row.finalCategory,
      }) === 'payment'
    ) {
      continue;
    }
    // /monthly aggregates signed amounts into a single "activity"
    // curve, so refunds/rewards stay IN (they net against month spend
    // for the same category in the UI). We only drop transfers and
    // investment / dividend flows that don't belong to any category.
    if (isNonCategorical(row.txnType, accountType)) {
      continue;
    }
    const month = String(row.date).slice(0, 7);
    const key = `${month}\0${row.currency}`;
    const existing = points.get(key) ?? {
      month,
      currency: row.currency,
      sumAmount: 0,
    };
    existing.sumAmount += amount;
    points.set(key, existing);
  }
  return Array.from(points.values());
}
