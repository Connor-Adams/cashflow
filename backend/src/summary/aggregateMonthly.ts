import { num, toUnits, fromUnits } from '../util/numbers';
import { classifyPositiveAmount, isNonCategorical } from './classifyTransactionFlow';
import { splitTxnByItems } from '../import/splitTxnByItems';
import type { ItemAllocationContext } from './loadItemAllocations';

/**
 * Transaction row shape consumed by the monthly aggregator. Mirrors the
 * `Transaction.findAll` attribute list in the GET /api/summary/monthly
 * route — kept here (rather than in a shared types file) so the route can
 * tell at a glance which fields the aggregator actually reads.
 */
export type MonthlyTxnRow = {
  id: number;
  accountId: number;
  date: string;
  currency: string;
  merchantRaw: string | null;
  merchantClean: string | null;
  finalCategory: string | null;
  finalBusiness: boolean;
  finalSplitType: string;
  amount: unknown;
  txnType: string | null;
  businessAmount?: string;
};

export type MonthlyPoint = { month: string; currency: string; sumAmount: number };
export type MonthlyCategoryPoint = {
  month: string;
  currency: string;
  category: string | null;
  sumAmount: number;
};
export type MonthlyResult = {
  points: MonthlyPoint[];
  categoryPoints: MonthlyCategoryPoint[];
};

/**
 * Aggregator for the /api/summary/monthly endpoint. Sums signed `amount`
 * per (month, currency) into a single "activity" curve and, when an
 * `itemContext` is supplied, also produces a per-(month, currency, category)
 * breakdown driven by `splitTxnByItems` — so an itemized receipt feeds its
 * line-item categories into the monthly trend instead of the txn category.
 *
 * Excluded:
 *  - statement payments (positive amount with txnType resolving to 'payment'
 *    via `classifyPositiveAmount` — not category data, would inflate)
 *  - non-categorical money movement (transfer / investment / dividend, plus
 *    anything on an investment account — see `classifyTransactionFlow`)
 *  - income (txnType='income', either sign) — inflow is not category spend
 *    or a category-offsetting credit; peeled from BOTH points and
 *    categoryPoints so a paycheck doesn't inflate the null/Uncategorized
 *    bucket or the activity curve (matches the dashboard income peel)
 *
 * Included:
 *  - refunds / rewards — they net against the same month's spend in the UI,
 *    which is what users expect
 *  - rows whose `num()` parse fails are silently skipped (legacy data)
 *
 * Sorting is left to the route so this stays a pure data transform.
 */
export function aggregateMonthly(
  rows: MonthlyTxnRow[],
  accountTypeById: Map<number, string | null>,
  itemContext?: ItemAllocationContext,
): MonthlyResult {
  const points = new Map<string, MonthlyPoint>();
  const categoryPoints = new Map<string, MonthlyCategoryPoint>();
  for (const row of rows) {
    const amount = num(row.amount);
    if (amount == null) continue;
    const accountType = accountTypeById.get(row.accountId);
    // Income (txnType='income') is inflow, not category spend nor a
    // category-offsetting credit. Peel it out entirely so it inflates
    // neither the activity curve (points) nor any category bucket
    // (categoryPoints) — both signs dropped (a negative income reversal is
    // money-movement, not spend). Keeps points == Σ categoryPoints intact.
    if (row.txnType === 'income') continue;
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
    existing.sumAmount += toUnits(amount);
    points.set(key, existing);

    const allocations = itemContext
      ? splitTxnByItems({
          txn: {
            id: row.id,
            amount: String(row.amount),
            currency: row.currency,
            finalCategory: row.finalCategory,
            finalBusiness: row.finalBusiness,
            finalSplitType: row.finalSplitType,
            businessAmount: row.businessAmount ?? '0',
          },
          links: itemContext.linksByTxn.get(row.id) ?? [],
          ordersById: itemContext.ordersById,
          itemsByOrder: itemContext.itemsByOrder,
        })
      : [
          {
            category: row.finalCategory,
            amount,
            businessAmount: 0,
            currency: row.currency,
          },
        ];

    for (const alloc of allocations) {
      const catKey = `${month}\0${row.currency}\0${alloc.category ?? ''}`;
      const catExisting = categoryPoints.get(catKey) ?? {
        month,
        currency: row.currency,
        category: alloc.category,
        sumAmount: 0,
      };
      catExisting.sumAmount += toUnits(alloc.amount);
      categoryPoints.set(catKey, catExisting);
    }
  }
  // Finalize: convert integer-unit accumulators back to dollars.
  for (const v of points.values()) {
    v.sumAmount = fromUnits(v.sumAmount);
  }
  for (const v of categoryPoints.values()) {
    v.sumAmount = fromUnits(v.sumAmount);
  }

  return {
    points: Array.from(points.values()),
    categoryPoints: Array.from(categoryPoints.values()),
  };
}
