import { num, toUnits, fromUnits } from '../util/numbers';
import { classifyFlow, countsTowardNetSpend } from './classifyTransactionFlow';
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
  finalCategoryId?: number | null;
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
  categoryId: number | null;
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
 * Rows are gated by `classifyFlow` — the dashboard headline's classifier —
 * so the curve reconciles with headline netSpend. Only 'spend' and 'credit'
 * rows count; excluded:
 *  - statement payments, both legs (any txnType='payment' row, plus positive
 *    amounts resolving to 'payment' via `classifyPositiveAmount` merchant
 *    text — not category data, would double count the card spend they cover)
 *  - non-categorical money movement (transfer / investment / dividend, plus
 *    anything on an investment account — see `classifyTransactionFlow`)
 *  - income (txnType='income', either sign) — inflow is not category spend
 *    or a category-offsetting credit; peeled from BOTH points and
 *    categoryPoints so a paycheck doesn't inflate the null/Uncategorized
 *    bucket or the activity curve (matches the dashboard income peel)
 *  - unsignaled positives classified 'skip' (txnType unknown deposits) and
 *    negative non-spend rows (e.g. a negative refund/reward reversal)
 *
 * Included:
 *  - spend, and positive refunds / rewards / credit-keyword rows — they net
 *    against the same month's spend in the UI, which is what users expect
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
    // Same classification as the dashboard headline: only rows that count
    // toward netSpend (spend, or a refund/reward credit that nets against it)
    // feed the activity curve. That drops, both signs:
    //  - income — inflow, not category spend nor a category-offsetting credit
    //  - statement payments, BOTH legs (positive card-side via txnType or
    //    merchant text; negative checking-side txnType='payment' is non-spend)
    //    — the card purchases they cover are already summed
    //  - transfers / investment / dividend flows and investment accounts
    //  - unsignaled positives the headline classifies 'skip' (e.g. "DEPOSIT
    //    FROM MOM", txnType unknown) — not a refund against spend
    // Keeps points == Σ categoryPoints and reconciles with headline netSpend.
    const flow = classifyFlow({
      amount,
      txnType: row.txnType,
      accountType,
      merchantRaw: row.merchantRaw,
      merchantClean: row.merchantClean,
      category: row.finalCategory,
    });
    if (!countsTowardNetSpend(flow)) continue;
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
            finalCategoryId: row.finalCategoryId ?? null,
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
            categoryId: row.finalCategoryId ?? null,
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
        categoryId: alloc.categoryId ?? null,
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
