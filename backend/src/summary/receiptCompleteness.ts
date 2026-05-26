/**
 * Receipt-completeness aggregation (#209).
 *
 * "Completeness" = how many SPEND transactions have a receipt attached, by
 * count and by absolute dollar amount. Drives the dashboard's coverage tile
 * and a "missing-receipt queue" so users can find the largest gaps first.
 *
 * Eligible txns = spend rows only:
 *   - negative amount (positive = refund/credit, excluded — see also
 *     classifyTransactionFlow.ts)
 *   - txnType NOT IN NON_SPEND_TXN_TYPES (transfer/investment/dividend/payment
 *     /refund/reward/income — money movement, not consumption)
 *
 * Filter taxonomy:
 *   - 'all'           — every eligible spend row
 *   - 'business'      — eligible rows where finalBusiness=true
 *   - 'tax-relevant'  — business OR finalCategory matches a TaxCategory.label
 *                       whose isDeductible=true (TaxCategory seeded by #208
 *                       once it lands; until then this returns just business
 *                       rows, gracefully)
 *
 * Cross-household isolation is enforced upstream by the router by passing the
 * household scope via `householdId` — this module is pure aggregation.
 */
import { Op, type WhereOptions } from 'sequelize';
import { Receipt, TaxCategory, Transaction } from '../models';
import { NON_SPEND_TXN_TYPES } from './classifyTransactionFlow';

export type ReceiptCompletenessFilter = 'all' | 'business' | 'tax-relevant';

export const RECEIPT_COMPLETENESS_FILTERS: readonly ReceiptCompletenessFilter[] = [
  'all',
  'business',
  'tax-relevant',
] as const;

export type CompletenessCurrencyBucket = {
  currency: string;
  totalCount: number;
  withReceiptCount: number;
  missingCount: number;
  totalAmount: number;
  withReceiptAmount: number;
  missingAmount: number;
  coverageByCount: number;
  coverageByAmount: number;
};

export type CompletenessResult = Omit<CompletenessCurrencyBucket, 'currency'> & {
  filter: ReceiptCompletenessFilter;
  /** ISO currency code when the request was scoped to a single currency, or
   *  null when the aggregation crosses currencies (per-currency totals live
   *  in `byCurrency`). */
  currency: string | null;
  /**
   * Always populated, even when a single-currency filter is supplied. When
   * `currency` is null this is the per-currency breakdown the dashboard uses
   * to render multi-currency stats; when `currency` is set this contains
   * exactly one row identical to the top-level totals (kept so the response
   * shape is uniform).
   */
  byCurrency: CompletenessCurrencyBucket[];
};

export type MissingReceiptRow = {
  id: number;
  date: string;
  currency: string;
  merchant: string;
  category: string | null;
  amount: number;
  finalBusiness: boolean;
};

type AggregateInput = {
  householdScope: WhereOptions;
  filter: ReceiptCompletenessFilter;
  currency: string | null;
};

type MissingInput = AggregateInput & {
  limit?: number;
};

/**
 * Build the Transaction WHERE for eligible spend rows. Negative-amount rows
 * with txnType not in NON_SPEND_TXN_TYPES, optionally currency-filtered,
 * optionally narrowed by the business / tax-relevant filter.
 *
 * For 'tax-relevant', the deductible category labels are loaded from the
 * TaxCategory table (so this query stays a single SELECT). When the table is
 * empty (default state pre-#208), the OR collapses to just finalBusiness=true.
 */
async function buildSpendWhere(
  scope: WhereOptions,
  filter: ReceiptCompletenessFilter,
  currency: string | null,
): Promise<WhereOptions> {
  const baseWhere: Record<string | symbol, unknown> = {
    ...scope,
    amount: { [Op.lt]: 0 },
    txnType: { [Op.notIn]: Array.from(NON_SPEND_TXN_TYPES) },
  };
  if (currency) {
    baseWhere.currency = currency;
  }
  if (filter === 'business') {
    baseWhere.finalBusiness = true;
  } else if (filter === 'tax-relevant') {
    const deductibleLabels = await TaxCategory.findAll({
      where: { isDeductible: true },
      attributes: ['label'],
    });
    const labels = deductibleLabels
      .map((row) => row.label)
      .filter((label): label is string => Boolean(label));
    if (labels.length === 0) {
      baseWhere.finalBusiness = true;
    } else {
      baseWhere[Op.or] = [
        { finalBusiness: true },
        { finalCategory: { [Op.in]: labels } },
      ];
    }
  }
  return baseWhere as WhereOptions;
}

function safeRatio(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  return numerator / denominator;
}

function emptyBucket(currency: string): CompletenessCurrencyBucket {
  return {
    currency,
    totalCount: 0,
    withReceiptCount: 0,
    missingCount: 0,
    totalAmount: 0,
    withReceiptAmount: 0,
    missingAmount: 0,
    coverageByCount: 0,
    coverageByAmount: 0,
  };
}

function finalizeBucket(bucket: CompletenessCurrencyBucket): CompletenessCurrencyBucket {
  return {
    ...bucket,
    missingCount: bucket.totalCount - bucket.withReceiptCount,
    missingAmount: round2(bucket.totalAmount - bucket.withReceiptAmount),
    totalAmount: round2(bucket.totalAmount),
    withReceiptAmount: round2(bucket.withReceiptAmount),
    coverageByCount: safeRatio(bucket.withReceiptCount, bucket.totalCount),
    coverageByAmount: safeRatio(bucket.withReceiptAmount, bucket.totalAmount),
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Aggregate receipt coverage for the household's spend.
 *
 * Two SQL passes (Sequelize, no raw SQL):
 *   1. List eligible spend rows (id, currency, abs amount).
 *   2. Look up which of those ids have at least one receipt.
 *
 * Then fold both into per-currency buckets and top-level totals.
 */
export async function aggregateReceiptCompleteness(
  input: AggregateInput,
): Promise<CompletenessResult> {
  const where = await buildSpendWhere(input.householdScope, input.filter, input.currency);
  const txns = await Transaction.findAll({
    where,
    attributes: ['id', 'amount', 'currency'],
  });
  const withReceiptIds = await receiptedTransactionIds(txns.map((t) => t.id));

  const buckets = new Map<string, CompletenessCurrencyBucket>();
  let totalCount = 0;
  let withReceiptCount = 0;
  let totalAmount = 0;
  let withReceiptAmount = 0;

  for (const t of txns) {
    const abs = Math.abs(Number(t.amount));
    const bucket = buckets.get(t.currency) ?? emptyBucket(t.currency);
    bucket.totalCount += 1;
    bucket.totalAmount += abs;
    const hasReceipt = withReceiptIds.has(t.id);
    if (hasReceipt) {
      bucket.withReceiptCount += 1;
      bucket.withReceiptAmount += abs;
    }
    buckets.set(t.currency, bucket);
    totalCount += 1;
    totalAmount += abs;
    if (hasReceipt) {
      withReceiptCount += 1;
      withReceiptAmount += abs;
    }
  }

  const byCurrency = Array.from(buckets.values())
    .map(finalizeBucket)
    .sort((a, b) => a.currency.localeCompare(b.currency));

  const headline = finalizeBucket({
    currency: input.currency ?? 'ALL',
    totalCount,
    withReceiptCount,
    missingCount: 0,
    totalAmount,
    withReceiptAmount,
    missingAmount: 0,
    coverageByCount: 0,
    coverageByAmount: 0,
  });
  return {
    ...headline,
    filter: input.filter,
    // `headline.currency` was set to 'ALL' as a placeholder when no currency
    // filter was supplied; the wire contract distinguishes "single currency
    // selected" from "aggregate" by returning `currency: null` in the latter
    // case, so we explicitly overwrite here.
    currency: input.currency,
    byCurrency,
  };
}

async function receiptedTransactionIds(txnIds: number[]): Promise<Set<number>> {
  if (txnIds.length === 0) return new Set();
  const rows = await Receipt.findAll({
    where: { transactionId: { [Op.in]: txnIds } },
    attributes: ['transactionId'],
  });
  return new Set(rows.map((r) => r.transactionId));
}

/**
 * Spend rows without a receipt, sorted by absolute amount descending so the
 * largest dollar-impact gaps surface first. The dashboard's missing-receipt
 * queue and #208's business-tax dashboard both consume this — the `filter`
 * parameter is the coordination point.
 */
export async function listMissingReceipts(input: MissingInput): Promise<MissingReceiptRow[]> {
  const where = await buildSpendWhere(input.householdScope, input.filter, input.currency);
  const candidates = await Transaction.findAll({
    where,
    attributes: [
      'id',
      'date',
      'amount',
      'currency',
      'merchantClean',
      'merchantRaw',
      'finalCategory',
      'finalBusiness',
    ],
  });
  const receipted = await receiptedTransactionIds(candidates.map((t) => t.id));
  const missing = candidates
    .filter((t) => !receipted.has(t.id))
    .map<MissingReceiptRow>((t) => ({
      id: t.id,
      date: t.date,
      currency: t.currency,
      // merchantClean is preferred for display; fall back to merchantRaw if a
      // weird import left it blank.
      merchant: t.merchantClean || t.merchantRaw,
      category: t.finalCategory ?? null,
      amount: Number(t.amount),
      finalBusiness: Boolean(t.finalBusiness),
    }))
    .sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));
  if (input.limit != null && input.limit > 0) {
    return missing.slice(0, input.limit);
  }
  return missing;
}

/**
 * Pure validator for the `filter` query string. Exported so routes can return
 * a 400 with a useful message and so unit tests don't have to hit the DB.
 */
export function parseFilter(raw: unknown): ReceiptCompletenessFilter | null {
  if (raw == null || raw === '') return 'all';
  const v = String(raw);
  return (RECEIPT_COMPLETENESS_FILTERS as readonly string[]).includes(v)
    ? (v as ReceiptCompletenessFilter)
    : null;
}
