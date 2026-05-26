/**
 * Merchant timeline aggregation (issue #219).
 *
 * Pure function: given a pre-filtered set of transaction rows for a single
 * merchant (the route applies visibility + merchant where clauses upstream),
 * returns the shape powering the merchant detail page —
 *   - lifetime totals (spend, credits, net, count, average, first/last date)
 *   - monthly trend (ascending by month)
 *   - per-category breakdown (descending by spend)
 *   - receipt coverage (% of rows with at least one Receipt row)
 *   - recurring flag (true if any row.isRecurring)
 *
 * Routes pass currency-filtered rows in; this module does NOT slice by
 * currency. The merchant key (canonical || clean || raw) resolution helper
 * is exported separately because the route needs it to match Sequelize
 * where-clauses against arbitrary URL path values.
 *
 * Spend/credit classification mirrors `aggregateDashboard.ts` so the
 * merchant detail page reconciles against the dashboard's per-merchant
 * tile (same numbers, smaller scope).
 */
import { num } from '../util/numbers';
import {
  classifyPositiveAmount,
  isNonSpend,
} from './classifyTransactionFlow';

export type MerchantTimelineTxnRow = {
  id: number;
  accountId: number;
  date: string;
  currency: string;
  finalCategory: string | null;
  finalBusiness: boolean;
  finalSplitType: string;
  merchantRaw: string | null;
  merchantClean: string | null;
  merchantCanonical: string | null;
  amount: unknown;
  txnType: string | null;
  isRecurring: boolean;
  /** Account type — used to gate non-spend classification (investment). */
  accountType?: string | null;
};

export type MerchantTimelineTotals = {
  totalSpend: number;
  totalCredits: number;
  netSpend: number;
  transactionCount: number;
  /** Average size of a spend row (totalSpend / spendCount). 0 if no spend rows. */
  averageTransaction: number;
  firstDate: string | null;
  lastDate: string | null;
};

export type MerchantMonthlyBucket = {
  month: string;
  totalSpend: number;
  totalCredits: number;
  netSpend: number;
  transactionCount: number;
};

export type MerchantCategoryBucket = {
  category: string | null;
  totalSpend: number;
  transactionCount: number;
};

export type MerchantReceiptCoverage = {
  totalCount: number;
  withReceiptCount: number;
  missingCount: number;
  /** withReceiptCount / totalCount, 0 when totalCount === 0 */
  coverageByCount: number;
};

export type MerchantTimelineResult = {
  totals: MerchantTimelineTotals;
  monthlyTrend: MerchantMonthlyBucket[];
  byCategory: MerchantCategoryBucket[];
  receiptCoverage: MerchantReceiptCoverage;
  isRecurring: boolean;
};

/**
 * Resolve the merchant grouping key from a row's three merchant columns.
 * Matches the precedence in aggregateDashboard.ts:187-191:
 *   merchantCanonical?.trim() || merchantClean?.trim() || merchantRaw?.trim()
 *     || '(unknown merchant)'
 */
export function resolveMerchantKey(row: {
  merchantCanonical: string | null;
  merchantClean: string | null;
  merchantRaw: string | null;
}): string {
  return (
    row.merchantCanonical?.trim() ||
    row.merchantClean?.trim() ||
    row.merchantRaw?.trim() ||
    '(unknown merchant)'
  );
}

export function aggregateMerchantTimeline(
  rows: MerchantTimelineTxnRow[],
  receiptTxnIds?: ReadonlySet<number>,
): MerchantTimelineResult {
  const totals: MerchantTimelineTotals = {
    totalSpend: 0,
    totalCredits: 0,
    netSpend: 0,
    transactionCount: 0,
    averageTransaction: 0,
    firstDate: null,
    lastDate: null,
  };
  const monthly = new Map<string, MerchantMonthlyBucket>();
  const byCategoryMap = new Map<string, MerchantCategoryBucket>();
  let spendCount = 0;
  let isRecurring = false;

  for (const row of rows) {
    const amount = num(row.amount);
    if (amount == null) continue;
    totals.transactionCount += 1;
    if (row.isRecurring) isRecurring = true;
    if (!totals.firstDate || row.date < totals.firstDate) totals.firstDate = row.date;
    if (!totals.lastDate || row.date > totals.lastDate) totals.lastDate = row.date;

    const nonSpend = isNonSpend(row.txnType, row.accountType ?? null);
    const positiveBucket =
      amount > 0
        ? classifyPositiveAmount({
            txnType: row.txnType,
            accountType: row.accountType ?? null,
            merchantRaw: row.merchantRaw,
            merchantClean: row.merchantClean,
            category: row.finalCategory,
          })
        : 'skip';

    const month = row.date.slice(0, 7);
    const monthBucket = monthly.get(month) ?? {
      month,
      totalSpend: 0,
      totalCredits: 0,
      netSpend: 0,
      transactionCount: 0,
    };
    monthBucket.transactionCount += 1;

    const categoryKey = row.finalCategory ?? '__null__';
    const catBucket = byCategoryMap.get(categoryKey) ?? {
      category: row.finalCategory,
      totalSpend: 0,
      transactionCount: 0,
    };
    catBucket.transactionCount += 1;

    if (amount < 0 && !nonSpend) {
      const spend = -amount;
      totals.totalSpend += spend;
      monthBucket.totalSpend += spend;
      catBucket.totalSpend += spend;
      spendCount += 1;
    } else if (positiveBucket === 'credit') {
      totals.totalCredits += amount;
      monthBucket.totalCredits += amount;
    }
    // 'payment' (positive statement payment) and other 'skip' branches do
    // not contribute to the merchant's spend/credit totals — matches the
    // dashboard merchantSummary aggregation.
    monthBucket.netSpend = monthBucket.totalSpend - monthBucket.totalCredits;
    monthly.set(month, monthBucket);
    byCategoryMap.set(categoryKey, catBucket);
  }

  totals.netSpend = totals.totalSpend - totals.totalCredits;
  totals.averageTransaction = spendCount > 0 ? totals.totalSpend / spendCount : 0;

  const monthlyTrend = Array.from(monthly.values()).sort((a, b) => a.month.localeCompare(b.month));
  const byCategory = Array.from(byCategoryMap.values()).sort((a, b) => {
    if (b.totalSpend !== a.totalSpend) return b.totalSpend - a.totalSpend;
    return b.transactionCount - a.transactionCount;
  });

  let withReceiptCount = 0;
  if (receiptTxnIds && receiptTxnIds.size > 0) {
    for (const row of rows) {
      if (receiptTxnIds.has(row.id)) withReceiptCount += 1;
    }
  }
  const totalCount = totals.transactionCount;
  const receiptCoverage: MerchantReceiptCoverage = {
    totalCount,
    withReceiptCount,
    missingCount: totalCount - withReceiptCount,
    coverageByCount: totalCount > 0 ? withReceiptCount / totalCount : 0,
  };

  return {
    totals,
    monthlyTrend,
    byCategory,
    receiptCoverage,
    isRecurring,
  };
}
