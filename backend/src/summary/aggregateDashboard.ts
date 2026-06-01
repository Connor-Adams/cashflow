import { num } from '../util/numbers';
import {
  classifyPositiveAmount,
  isNonCategorical,
  isNonSpend,
} from './classifyTransactionFlow';
import { splitTxnByItems } from '../import/splitTxnByItems';
import type { ItemAllocationContext } from './loadItemAllocations';

/**
 * Transaction row shape consumed by the dashboard aggregator. Mirrors the
 * `Transaction.findAll` attribute list in the GET /api/summary/dashboard
 * route — kept here (rather than in a shared types file) so the route can
 * tell at a glance which fields the aggregator actually reads.
 */
export type SummaryTxnRow = {
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
  reviewFlag: boolean;
  txnType: string | null;
  /**
   * When non-null and txnType==='refund' this row is a refund tied back to
   * an original purchase. The dashboard aggregator splits these out as
   * `refundCredits` so users can see how much of their headline credits is
   * specifically money-back-on-purchases.
   */
  linkedTransactionId?: number | null;
  businessAmount?: string;
};

/** Account row shape consumed by the aggregator for type/short-code lookups. */
export type AccountRow = {
  id: number;
  name: string;
  shortCode: string | null;
  accountType: string | null;
};

/**
 * All aggregate Maps produced by a single pass over the transaction rows.
 * The route reads each value, converts to an array, sorts where needed, and
 * returns to the client. Sorting and serialization stay in the route so the
 * aggregator remains a pure data-shape transformation.
 */
export type DashboardAggregates = {
  byCategory: Map<
    string,
    {
      currency: string;
      category: string | null;
      finalBusiness: boolean;
      finalSplitType: string;
      sumAmount: number;
    }
  >;
  metricsByCurrency: Map<
    string,
    {
      currency: string;
      totalSpend: number;
      totalCredits: number;
      totalPayments: number;
      netSpend: number;
      transactionCount: number;
      /**
       * Subset of totalCredits whose row is a refund AND has a non-null
       * linked_transaction_id — i.e. the refund detector (or manual link)
       * tied it back to an original purchase. Lets the dashboard render a
       * "Refunded $X via Y linked refunds" line so users can see what
       * portion of their headline credits is "money back" vs. cashback,
       * statement-credit, or other.
       */
      refundCredits: number;
      /** Count of refund rows that contributed to refundCredits. */
      linkedRefundCount: number;
    }
  >;
  monthlyByCurrency: Map<
    string,
    {
      month: string;
      currency: string;
      totalSpend: number;
      totalCredits: number;
      totalPayments: number;
      netSpend: number;
    }
  >;
  netSpendBySplit: Map<
    string,
    {
      currency: string;
      splitType: string;
      totalSpend: number;
      totalCredits: number;
      netSpend: number;
    }
  >;
  netSpendByBusiness: Map<
    string,
    {
      currency: string;
      business: boolean;
      totalSpend: number;
      totalCredits: number;
      netSpend: number;
      income: number;
    }
  >;
  categoryReports: Map<
    string,
    {
      currency: string;
      category: string | null;
      totalSpend: number;
      totalCredits: number;
      netSpend: number;
    }
  >;
  merchantSummaries: Map<
    string,
    {
      currency: string;
      merchant: string;
      totalSpend: number;
      totalCredits: number;
      totalPayments: number;
      netSpend: number;
      transactionCount: number;
      lastDate: string;
      reviewCount: number;
    }
  >;
  accountSummaries: Map<
    string,
    {
      currency: string;
      accountId: number;
      accountName: string;
      accountShortCode: string | null;
      totalSpend: number;
      totalCredits: number;
      totalPayments: number;
      netSpend: number;
      transactionCount: number;
      reviewCount: number;
    }
  >;
  reviewQueue: Array<{
    id: number;
    date: string;
    currency: string;
    merchant: string;
    accountName: string;
    category: string | null;
    amount: number;
  }>;
};

/**
 * Single-pass aggregator powering the /api/summary/dashboard endpoint.
 *
 * For each transaction row, this:
 *  - classifies the amount via `classifyPositiveAmount` / `isNonSpend` to
 *    route the value into the correct bucket (spend / credit / payment /
 *    skip — see `classifyTransactionFlow.ts` for the rules)
 *  - updates seven per-currency / per-bucket Maps in lock-step so the
 *    headline numbers reconcile against the breakdowns
 *  - appends review-flagged rows to a queue (sorted by the route)
 *
 * Sorting, serialization, and JSON shaping are intentionally left to the
 * route — this function is a pure data-transform with no I/O.
 *
 * Rows whose amount can't be parsed by `num()` are silently skipped, same
 * as the original inline behavior.
 */
export function aggregateDashboard(
  rows: SummaryTxnRow[],
  accountById: Map<number, AccountRow>,
  itemContext?: ItemAllocationContext,
): DashboardAggregates {
  const byCategory: DashboardAggregates['byCategory'] = new Map();
  const metricsByCurrency: DashboardAggregates['metricsByCurrency'] = new Map();
  const monthlyByCurrency: DashboardAggregates['monthlyByCurrency'] = new Map();
  const netSpendBySplit: DashboardAggregates['netSpendBySplit'] = new Map();
  const netSpendByBusiness: DashboardAggregates['netSpendByBusiness'] = new Map();
  const categoryReports: DashboardAggregates['categoryReports'] = new Map();
  const merchantSummaries: DashboardAggregates['merchantSummaries'] = new Map();
  const accountSummaries: DashboardAggregates['accountSummaries'] = new Map();
  const reviewQueue: DashboardAggregates['reviewQueue'] = [];

  for (const row of rows) {
    const amount = num(row.amount);
    if (amount == null) continue;
    const currency = row.currency;
    const month = row.date.slice(0, 7);
    const merchant =
      row.merchantCanonical?.trim() ||
      row.merchantClean?.trim() ||
      row.merchantRaw?.trim() ||
      '(unknown merchant)';
    const account = accountById.get(row.accountId);
    const accountName = account?.name ?? `Account ${row.accountId}`;
    // Spend totals must exclude transfers, investment buys, dividend
    // credits, statement payments, refunds and rewards — these aren't
    // consumption. Also exclude any negative amount on an investment
    // account regardless of txnType (belt-and-suspenders for legacy data).
    const nonSpend = isNonSpend(row.txnType, account?.accountType);
    const metrics = metricsByCurrency.get(currency) ?? {
      currency,
      totalSpend: 0,
      totalCredits: 0,
      totalPayments: 0,
      netSpend: 0,
      transactionCount: 0,
      refundCredits: 0,
      linkedRefundCount: 0,
    };
    metrics.transactionCount += 1;

    // Route positives via the authoritative classifier: txnType wins,
    // then merchant regex as fallback. 'skip' = non-categorical money
    // movement (transfer/invest/dividend) — contributes to nothing.
    const positiveBucket =
      amount > 0
        ? classifyPositiveAmount({
            txnType: row.txnType,
            accountType: account?.accountType,
            merchantRaw: row.merchantRaw,
            merchantClean: row.merchantClean,
            category: row.finalCategory,
          })
        : 'skip';
    const merchantKey = `${currency}\0${merchant}`;
    const merchantSummary = merchantSummaries.get(merchantKey) ?? {
      currency,
      merchant,
      totalSpend: 0,
      totalCredits: 0,
      totalPayments: 0,
      netSpend: 0,
      transactionCount: 0,
      lastDate: row.date,
      reviewCount: 0,
    };
    merchantSummary.transactionCount += 1;
    if (row.date > merchantSummary.lastDate) merchantSummary.lastDate = row.date;
    if (row.reviewFlag) merchantSummary.reviewCount += 1;

    const accountKey = `${currency}\0${row.accountId}`;
    const accountSummary = accountSummaries.get(accountKey) ?? {
      currency,
      accountId: row.accountId,
      accountName,
      accountShortCode: account?.shortCode ?? null,
      totalSpend: 0,
      totalCredits: 0,
      totalPayments: 0,
      netSpend: 0,
      transactionCount: 0,
      reviewCount: 0,
    };
    accountSummary.transactionCount += 1;
    if (row.reviewFlag) accountSummary.reviewCount += 1;

    if (amount < 0 && !nonSpend) {
      metrics.totalSpend += -amount;
      merchantSummary.totalSpend += -amount;
      accountSummary.totalSpend += -amount;
    } else if (positiveBucket === 'payment') {
      metrics.totalPayments += amount;
      merchantSummary.totalPayments += amount;
      accountSummary.totalPayments += amount;
    } else if (positiveBucket === 'credit') {
      metrics.totalCredits += amount;
      merchantSummary.totalCredits += amount;
      accountSummary.totalCredits += amount;
      // Refund-attributable credits (issue #215): a refund row counts only
      // when it's tied back to an original purchase, so reward/cashback/
      // statement-credit rows that route through the same 'credit' bucket
      // don't inflate the "refunded" subtotal.
      if (row.txnType === 'refund' && row.linkedTransactionId != null) {
        metrics.refundCredits += amount;
        metrics.linkedRefundCount += 1;
      }
    }
    // 'skip' (positive non-categorical) and negative non-spend fall
    // through without contributing to any bucket — matches the
    // per-category aggregation below so the headline reconciles.
    metrics.netSpend = metrics.totalSpend - metrics.totalCredits;
    merchantSummary.netSpend = merchantSummary.totalSpend - merchantSummary.totalCredits;
    accountSummary.netSpend = accountSummary.totalSpend - accountSummary.totalCredits;
    metricsByCurrency.set(currency, metrics);
    merchantSummaries.set(merchantKey, merchantSummary);
    accountSummaries.set(accountKey, accountSummary);

    if (row.reviewFlag) {
      reviewQueue.push({
        id: row.id,
        date: row.date,
        currency,
        merchant,
        accountName,
        category: row.finalCategory,
        amount,
      });
    }

    // Per-category skip: statement payments (positive) aren't category
    // signal. Refunds/rewards/income (positiveBucket==='credit') stay
    // IN — they net against category spend meaningfully (Amazon refund
    // credits the Groceries category it offset).
    if (amount > 0 && positiveBucket === 'payment') {
      continue;
    }
    // Non-categorical (transfer/invest/dividend, either sign, or any
    // invest-account row) is money movement, not category data.
    if (isNonCategorical(row.txnType, account?.accountType)) {
      continue;
    }
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
      const key = [
        row.currency,
        alloc.category ?? '',
        row.finalBusiness ? '1' : '0',
        row.finalSplitType,
      ].join('\0');
      const existing = byCategory.get(key) ?? {
        currency: row.currency,
        category: alloc.category,
        finalBusiness: row.finalBusiness,
        finalSplitType: row.finalSplitType,
        sumAmount: 0,
      };
      existing.sumAmount += alloc.amount;
      byCategory.set(key, existing);
    }

    const monthlyKey = `${month}\0${currency}`;
    const monthly = monthlyByCurrency.get(monthlyKey) ?? {
      month,
      currency,
      totalSpend: 0,
      totalCredits: 0,
      totalPayments: 0,
      netSpend: 0,
    };
    const splitKey = `${currency}\0${row.finalSplitType}`;
    const split = netSpendBySplit.get(splitKey) ?? {
      currency,
      splitType: row.finalSplitType,
      totalSpend: 0,
      totalCredits: 0,
      netSpend: 0,
    };
    if (amount < 0 && !nonSpend) {
      const spend = -amount;
      monthly.totalSpend += spend;
      split.totalSpend += spend;
    } else if (amount > 0) {
      monthly.totalCredits += amount;
      split.totalCredits += amount;
    }
    // Note: negative-amount non-spend rows (transfers, investment buys, etc)
    // contribute to neither side; they're tracked elsewhere (transaction
    // count is still incremented above) but don't move spend or credit
    // totals because they aren't consumption nor income.
    monthly.netSpend = monthly.totalSpend - monthly.totalCredits;
    split.netSpend = split.totalSpend - split.totalCredits;
    monthlyByCurrency.set(monthlyKey, monthly);
    netSpendBySplit.set(splitKey, split);

    // Per-allocation business/personal split: an item's business_use% rides
    // on the allocation, so one row can land in both business=true and
    // business=false buckets. The pre-allocator path keyed on row.finalBusiness
    // and dropped 100% of the row into a single bucket.
    for (const alloc of allocations) {
      const businessPart = alloc.businessAmount;
      const personalPart = alloc.amount - alloc.businessAmount;
      for (const [isBiz, part] of [
        [true, businessPart],
        [false, personalPart],
      ] as const) {
        if (part === 0) continue;
        const businessKey = `${currency}\0${isBiz ? '1' : '0'}`;
        const business = netSpendByBusiness.get(businessKey) ?? {
          currency,
          business: isBiz,
          totalSpend: 0,
          totalCredits: 0,
          netSpend: 0,
          income: 0,
        };
        if (part < 0 && !nonSpend) {
          business.totalSpend += -part;
        } else if (part > 0) {
          if (row.txnType === 'income') {
            business.income += part;
          } else {
            business.totalCredits += part;
          }
        }
        business.netSpend = business.totalSpend - business.totalCredits;
        netSpendByBusiness.set(businessKey, business);
      }
    }

    for (const alloc of allocations) {
      const categoryKey = `${currency}\0${alloc.category ?? ''}`;
      const category = categoryReports.get(categoryKey) ?? {
        currency,
        category: alloc.category,
        totalSpend: 0,
        totalCredits: 0,
        netSpend: 0,
      };
      if (alloc.amount < 0 && !nonSpend) {
        category.totalSpend += -alloc.amount;
      } else if (alloc.amount > 0) {
        category.totalCredits += alloc.amount;
      }
      category.netSpend = category.totalSpend - category.totalCredits;
      categoryReports.set(categoryKey, category);
    }
  }

  return {
    byCategory,
    metricsByCurrency,
    monthlyByCurrency,
    netSpendBySplit,
    netSpendByBusiness,
    categoryReports,
    merchantSummaries,
    accountSummaries,
    reviewQueue,
  };
}
