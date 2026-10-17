import { toUnits, fromUnits } from '../util/numbers';

/**
 * Per-currency, per-categoryId NET spend from signed points (each carrying a
 * `currency`, `categoryId`, and signed `sumAmount` where negative = spend,
 * positive = refund/credit). Skips null categoryIds. Result:
 *   Map<currency, Map<categoryId, netSpend>>
 * suitable for `buildRollupRowsByCurrency`.
 *
 * Signed amounts are summed per (currency, categoryId) FIRST and only then
 * converted to spend (−net). The inputs fan one category across several
 * buckets (dashboard byCategory keys on business + split type), so taking
 * |bucket| before summing would ADD a refund in one bucket to the spend in
 * another (−200 shared purchase + 50 personal refund → 250, not 150).
 *
 * A net-refunded category yields NEGATIVE spend — the same convention as
 * `categoryReports.netSpend` (totalSpend − totalCredits) — and it rolls up
 * into its parent as a reduction, so parent totals still reconcile with the
 * headline netSpend.
 */
export function netSpendByCurrencyCategory(
  points: Array<{ currency: string; categoryId: number | null; sumAmount: number }>,
): Map<string, Map<number, number>> {
  const outer = new Map<string, Map<number, number>>();
  for (const p of points) {
    if (p.categoryId == null) continue;
    let inner = outer.get(p.currency);
    if (!inner) {
      inner = new Map();
      outer.set(p.currency, inner);
    }
    // Accumulate in integer units to avoid float drift across buckets.
    inner.set(p.categoryId, (inner.get(p.categoryId) ?? 0) - toUnits(p.sumAmount));
  }
  for (const inner of outer.values()) {
    // `|| 0` normalises -0 (a category with no net movement) to 0.
    for (const [id, units] of inner) inner.set(id, fromUnits(units) || 0);
  }
  return outer;
}
