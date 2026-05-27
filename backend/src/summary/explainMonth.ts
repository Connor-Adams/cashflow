/**
 * Pure aggregator for the "Explain this month" report (Cashflow #225).
 *
 * Given two consecutive months of transactions, the current household's
 * subscriptions, the per-transaction receipt set, and the currency filter,
 * builds a deterministic narrative breakdown of:
 *
 *   - top spend changes by category vs. previous month
 *   - subscription changes (new this month, cancelled this month, price up)
 *   - missing receipts on big-ticket spend
 *   - review-needed transactions (reviewFlag = true)
 *   - business-spend summary (finalBusiness = true, MoM)
 *
 * The aggregator is HTTP-agnostic and DB-agnostic — it operates on plain
 * arrays the route hands in, so it's trivially unit-testable and the same
 * shape can be fed from a job runner or background queue later.
 *
 * Each Finding row carries a `transactionFilter` payload — a tiny URL/state
 * fragment the frontend uses to deep-link the finding into the existing
 * TransactionsPage filters. That satisfies the AC bullet "findings link to
 * source transaction filters" without baking presentation into the
 * aggregator.
 */

import { num } from '../util/numbers';

/** Transaction row consumed by the aggregator. Mirrors the attribute list
 *  the route requests from Sequelize — kept here so editors get type
 *  hints, but the route is responsible for keeping the columns in sync. */
export interface ExplainMonthTxnRow {
  id: number;
  date: string;
  currency: string;
  amount: unknown;
  finalCategory: string | null;
  finalBusiness: boolean;
  merchantClean: string | null;
  merchantRaw: string | null;
  reviewFlag: boolean;
  receiptCount: number;
}

/** Subscription row consumed by the aggregator. Same shape as
 *  LeakSubscription minus a few fields we don't need. */
export interface ExplainMonthSubRow {
  id: number;
  merchantName: string;
  currency: string;
  amount: number;
  cadence: 'monthly' | 'weekly';
  annualizedCost: number;
  status: 'active' | 'cancelled' | 'ignored' | 'unknown';
  priceChangeDetected: boolean;
  category: string | null;
  lastChargeDate: string;
  createdAt: string;
  updatedAt: string;
}

export type FindingKind =
  | 'spend_change'
  | 'missing_receipt'
  | 'subscription_change'
  | 'review_needed'
  | 'business_summary';

export type FindingSeverity = 'low' | 'medium' | 'high';

export interface TransactionFilter {
  dateFrom?: string;
  dateTo?: string;
  category?: string;
  merchant?: string;
  businessOnly?: boolean;
  reviewFlag?: boolean;
  currency?: string;
}

export interface Finding {
  id: string;
  kind: FindingKind;
  title: string;
  summary: string;
  currency: string;
  /** Net dollar impact for the period (positive = spent more, negative =
   *  spent less). For non-monetary findings (review backlog count) this
   *  is 0 and the caller can fall back to `summary`. */
  monthlyImpact: number;
  severity: FindingSeverity;
  supportingTransactionIds: number[];
  transactionFilter: TransactionFilter;
  meta: Record<string, unknown>;
}

export interface CategoryDelta {
  category: string;
  current: number;
  previous: number;
  delta: number;
  deltaPct: number | null;
}

export interface MonthOverMonth {
  currency: string;
  currentSpend: number;
  previousSpend: number;
  spendDelta: number;
  currentIncome: number;
  previousIncome: number;
  incomeDelta: number;
  netCurrent: number;
  netPrevious: number;
  netDelta: number;
  byCategory: CategoryDelta[];
}

export interface ExplainMonthResult {
  month: string;
  previousMonth: string;
  monthOverMonth: MonthOverMonth[];
  findings: Finding[];
  /** Optional narrative summary — null when no AI provider is configured
   *  or when ai=false was passed. The aggregator itself never calls AI;
   *  the route layer fills this in. */
  aiSummary: string | null;
}

export interface ExplainMonthInput {
  month: string; // YYYY-MM
  currentTxns: ExplainMonthTxnRow[];
  previousTxns: ExplainMonthTxnRow[];
  subscriptions: ExplainMonthSubRow[];
  /** Currency filter (uppercase 3 letters) or null for all currencies. */
  currency: string | null;
  /** Dollar threshold above which a missing-receipt finding is emitted.
   *  Per-currency — same value used across currencies. */
  missingReceiptThreshold?: number;
  /** Cap on number of spend_change findings. Categories with the largest
   *  absolute delta come first. */
  spendChangeLimit?: number;
}

const DEFAULT_MISSING_RECEIPT_THRESHOLD = 50;
const DEFAULT_SPEND_CHANGE_LIMIT = 5;

/** Year-month string ("2026-05") for an ISO date. */
function ymOf(date: string): string {
  return date.slice(0, 7);
}

/** Previous month label (YYYY-MM) given a YYYY-MM input. */
export function previousMonth(month: string): string {
  // Parse without relying on Date timezone semantics.
  const [yStr, mStr] = month.split('-');
  const y = Number(yStr);
  const m = Number(mStr);
  if (!Number.isFinite(y) || !Number.isFinite(m) || m < 1 || m > 12) {
    return month;
  }
  if (m === 1) return `${y - 1}-12`;
  return `${y}-${String(m - 1).padStart(2, '0')}`;
}

/** First/last day (YYYY-MM-DD) of the given YYYY-MM string. */
export function monthBounds(month: string): { from: string; to: string } {
  const [yStr, mStr] = month.split('-');
  const y = Number(yStr);
  const m = Number(mStr);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return {
    from: `${month}-01`,
    to: `${month}-${String(last).padStart(2, '0')}`,
  };
}

interface CurrencyBucket {
  currency: string;
  spend: number;
  income: number;
  byCategory: Map<string, number>;
}

/** Compute per-currency totals from a list of transactions. Positive
 *  amounts are income; negative amounts are spend (recorded as absolute
 *  value). Income includes refunds/rewards — they net against spend at
 *  the byCategory level too, which matches how /summary/monthly treats
 *  them. */
function tallyByCurrency(rows: ExplainMonthTxnRow[]): Map<string, CurrencyBucket> {
  const out = new Map<string, CurrencyBucket>();
  for (const row of rows) {
    const amount = num(row.amount);
    if (amount == null) continue;
    const bucket = out.get(row.currency) ?? {
      currency: row.currency,
      spend: 0,
      income: 0,
      byCategory: new Map<string, number>(),
    };
    if (amount < 0) {
      bucket.spend += Math.abs(amount);
    } else {
      bucket.income += amount;
    }
    const cat = row.finalCategory ?? '(uncategorized)';
    const existing = bucket.byCategory.get(cat) ?? 0;
    bucket.byCategory.set(cat, existing + amount);
    out.set(row.currency, bucket);
  }
  return out;
}

function pctChange(current: number, previous: number): number | null {
  if (previous === 0) return null;
  return ((current - previous) / Math.abs(previous)) * 100;
}

function buildMonthOverMonth(
  currentTxns: ExplainMonthTxnRow[],
  previousTxns: ExplainMonthTxnRow[],
  currencyFilter: string | null,
): MonthOverMonth[] {
  const cur = tallyByCurrency(currentTxns);
  const prev = tallyByCurrency(previousTxns);
  const allCurrencies = new Set<string>([...cur.keys(), ...prev.keys()]);
  const out: MonthOverMonth[] = [];
  for (const currency of allCurrencies) {
    if (currencyFilter && currency !== currencyFilter) continue;
    const c = cur.get(currency);
    const p = prev.get(currency);
    const currentSpend = c?.spend ?? 0;
    const previousSpend = p?.spend ?? 0;
    const currentIncome = c?.income ?? 0;
    const previousIncome = p?.income ?? 0;
    const netCurrent = currentIncome - currentSpend;
    const netPrevious = previousIncome - previousSpend;
    const allCats = new Set<string>([
      ...(c?.byCategory.keys() ?? []),
      ...(p?.byCategory.keys() ?? []),
    ]);
    const byCategory: CategoryDelta[] = [];
    for (const cat of allCats) {
      const cv = c?.byCategory.get(cat) ?? 0;
      const pv = p?.byCategory.get(cat) ?? 0;
      byCategory.push({
        category: cat,
        current: cv,
        previous: pv,
        delta: cv - pv,
        deltaPct: pctChange(cv, pv),
      });
    }
    // Sort by absolute delta desc for predictable order.
    byCategory.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
    out.push({
      currency,
      currentSpend,
      previousSpend,
      spendDelta: currentSpend - previousSpend,
      currentIncome,
      previousIncome,
      incomeDelta: currentIncome - previousIncome,
      netCurrent,
      netPrevious,
      netDelta: netCurrent - netPrevious,
      byCategory,
    });
  }
  return out.sort((a, b) => a.currency.localeCompare(b.currency));
}

function severityForDelta(absDelta: number, base: number): FindingSeverity {
  if (absDelta >= 500 || (base > 0 && absDelta / base >= 1)) return 'high';
  if (absDelta >= 100 || (base > 0 && absDelta / base >= 0.25)) return 'medium';
  return 'low';
}

function spendChangeFindings(
  monthOverMonth: MonthOverMonth[],
  month: string,
  previousLabel: string,
  spendChangeLimit: number,
): Finding[] {
  const out: Finding[] = [];
  for (const mom of monthOverMonth) {
    const movers = mom.byCategory
      .filter((c) => Math.abs(c.delta) >= 1) // skip noise under $1
      .slice(0, spendChangeLimit);
    for (const cat of movers) {
      const direction = cat.delta > 0 ? 'up' : cat.delta < 0 ? 'down' : 'flat';
      if (direction === 'flat') continue;
      const arrow = direction === 'up' ? 'up' : 'down';
      const absDelta = Math.abs(cat.delta);
      const pctNote =
        cat.deltaPct == null
          ? ' (no previous-month baseline)'
          : ` (${Math.abs(cat.deltaPct).toFixed(0)}% ${arrow})`;
      const baseForSev =
        direction === 'up' ? Math.abs(cat.previous) : Math.abs(cat.current);
      const sev = severityForDelta(absDelta, baseForSev);
      const bounds = monthBounds(month);
      out.push({
        id: `spend_change-${mom.currency}-${cat.category}`,
        kind: 'spend_change',
        title: `${cat.category} ${arrow} ${absDelta.toFixed(2)} ${mom.currency}`,
        summary: `${cat.category} moved from ${cat.previous.toFixed(2)} to ${cat.current.toFixed(2)} ${mom.currency}${pctNote}.`,
        currency: mom.currency,
        monthlyImpact: cat.delta,
        severity: sev,
        supportingTransactionIds: [],
        transactionFilter: {
          dateFrom: bounds.from,
          dateTo: bounds.to,
          category: cat.category === '(uncategorized)' ? undefined : cat.category,
          currency: mom.currency,
        },
        meta: {
          previousMonth: previousLabel,
          previousAmount: cat.previous,
          currentAmount: cat.current,
          deltaPct: cat.deltaPct,
        },
      });
    }
  }
  return out;
}

function missingReceiptFindings(
  currentTxns: ExplainMonthTxnRow[],
  currencyFilter: string | null,
  threshold: number,
): Finding[] {
  const out: Finding[] = [];
  for (const txn of currentTxns) {
    if (currencyFilter && txn.currency !== currencyFilter) continue;
    const amount = num(txn.amount);
    if (amount == null) continue;
    if (amount >= 0) continue; // we only care about spend
    const abs = Math.abs(amount);
    if (abs < threshold) continue;
    if (txn.receiptCount > 0) continue;
    const merchant = txn.merchantClean?.trim() || txn.merchantRaw?.trim() || 'Unknown merchant';
    const sev: FindingSeverity = abs >= threshold * 4 ? 'high' : abs >= threshold * 2 ? 'medium' : 'low';
    out.push({
      id: `missing_receipt-${txn.id}`,
      kind: 'missing_receipt',
      title: `Missing receipt: ${merchant}`,
      summary: `${merchant} on ${txn.date} for ${abs.toFixed(2)} ${txn.currency} has no receipt attached.`,
      currency: txn.currency,
      monthlyImpact: 0,
      severity: sev,
      supportingTransactionIds: [txn.id],
      transactionFilter: {
        dateFrom: txn.date,
        dateTo: txn.date,
        merchant,
        currency: txn.currency,
      },
      meta: {
        amount: abs,
        threshold,
      },
    });
  }
  return out.sort((a, b) => {
    const av = Number(a.meta.amount) || 0;
    const bv = Number(b.meta.amount) || 0;
    return bv - av;
  });
}

function subscriptionChangeFindings(
  subscriptions: ExplainMonthSubRow[],
  month: string,
  currencyFilter: string | null,
): Finding[] {
  const out: Finding[] = [];
  const bounds = monthBounds(month);
  const monthFrom = bounds.from;
  const monthTo = bounds.to;
  const isInMonth = (iso: string): boolean => iso >= monthFrom && iso <= monthTo;
  for (const sub of subscriptions) {
    if (currencyFilter && sub.currency !== currencyFilter) continue;
    const createdMonth = ymOf(sub.createdAt);
    const updatedMonth = ymOf(sub.updatedAt);
    const newThisMonth = createdMonth === month;
    const cancelledThisMonth =
      sub.status === 'cancelled' && updatedMonth === month;
    const priceUp = sub.priceChangeDetected && isInMonth(sub.lastChargeDate);
    if (!newThisMonth && !cancelledThisMonth && !priceUp) continue;
    const reasonParts: string[] = [];
    if (newThisMonth) reasonParts.push('new this month');
    if (cancelledThisMonth) reasonParts.push('cancelled this month');
    if (priceUp) reasonParts.push('price changed');
    const reason = reasonParts.join(', ');
    const monthlyImpact = newThisMonth
      ? -sub.amount * (sub.cadence === 'weekly' ? 4 : 1)
      : cancelledThisMonth
        ? sub.amount * (sub.cadence === 'weekly' ? 4 : 1)
        : 0;
    const sev: FindingSeverity =
      sub.annualizedCost >= 300 ? 'high' : sub.annualizedCost >= 120 ? 'medium' : 'low';
    out.push({
      id: `subscription_change-${sub.id}`,
      kind: 'subscription_change',
      title: `${sub.merchantName}: ${reason}`,
      summary: `${sub.merchantName} (${sub.amount.toFixed(2)} ${sub.currency} / ${sub.cadence}) — ${reason}.`,
      currency: sub.currency,
      monthlyImpact,
      severity: sev,
      supportingTransactionIds: [],
      transactionFilter: {
        dateFrom: monthFrom,
        dateTo: monthTo,
        merchant: sub.merchantName,
        currency: sub.currency,
      },
      meta: {
        subscriptionId: sub.id,
        newThisMonth,
        cancelledThisMonth,
        priceChangeDetected: priceUp,
        annualizedCost: sub.annualizedCost,
        cadence: sub.cadence,
        category: sub.category,
      },
    });
  }
  return out.sort((a, b) => {
    const aCost = Number(a.meta.annualizedCost) || 0;
    const bCost = Number(b.meta.annualizedCost) || 0;
    return bCost - aCost;
  });
}

function reviewNeededFindings(
  currentTxns: ExplainMonthTxnRow[],
  month: string,
  currencyFilter: string | null,
): Finding[] {
  const flagged = currentTxns.filter(
    (t) => t.reviewFlag && (!currencyFilter || t.currency === currencyFilter),
  );
  if (flagged.length === 0) return [];
  const bounds = monthBounds(month);
  // One aggregated finding per currency present in flagged rows.
  const byCurrency = new Map<
    string,
    { count: number; absTotal: number; ids: number[] }
  >();
  for (const txn of flagged) {
    const amount = num(txn.amount);
    const abs = amount == null ? 0 : Math.abs(amount);
    const entry = byCurrency.get(txn.currency) ?? {
      count: 0,
      absTotal: 0,
      ids: [],
    };
    entry.count += 1;
    entry.absTotal += abs;
    if (entry.ids.length < 20) entry.ids.push(txn.id);
    byCurrency.set(txn.currency, entry);
  }
  const out: Finding[] = [];
  for (const [currency, entry] of byCurrency) {
    const sev: FindingSeverity =
      entry.count >= 10 ? 'high' : entry.count >= 3 ? 'medium' : 'low';
    out.push({
      id: `review_needed-${currency}`,
      kind: 'review_needed',
      title: `${entry.count} transaction${entry.count === 1 ? '' : 's'} flagged for review`,
      summary: `${entry.count} ${currency} transaction${
        entry.count === 1 ? '' : 's'
      } totalling ${entry.absTotal.toFixed(2)} ${currency} still need review this month.`,
      currency,
      monthlyImpact: 0,
      severity: sev,
      supportingTransactionIds: entry.ids,
      transactionFilter: {
        dateFrom: bounds.from,
        dateTo: bounds.to,
        reviewFlag: true,
        currency,
      },
      meta: {
        count: entry.count,
        absTotal: entry.absTotal,
      },
    });
  }
  return out.sort((a, b) => a.currency.localeCompare(b.currency));
}

function businessSummaryFindings(
  currentTxns: ExplainMonthTxnRow[],
  previousTxns: ExplainMonthTxnRow[],
  month: string,
  previousLabel: string,
  currencyFilter: string | null,
): Finding[] {
  const bounds = monthBounds(month);
  const tally = (rows: ExplainMonthTxnRow[]): Map<string, { count: number; spend: number }> => {
    const out = new Map<string, { count: number; spend: number }>();
    for (const t of rows) {
      if (!t.finalBusiness) continue;
      if (currencyFilter && t.currency !== currencyFilter) continue;
      const amount = num(t.amount);
      if (amount == null) continue;
      if (amount >= 0) continue; // business income (refunds) doesn't drive this summary
      const e = out.get(t.currency) ?? { count: 0, spend: 0 };
      e.count += 1;
      e.spend += Math.abs(amount);
      out.set(t.currency, e);
    }
    return out;
  };
  const cur = tally(currentTxns);
  const prev = tally(previousTxns);
  const out: Finding[] = [];
  const allCurrencies = new Set<string>([...cur.keys(), ...prev.keys()]);
  for (const currency of allCurrencies) {
    const c = cur.get(currency) ?? { count: 0, spend: 0 };
    const p = prev.get(currency) ?? { count: 0, spend: 0 };
    if (c.count === 0 && p.count === 0) continue;
    const delta = c.spend - p.spend;
    const sev: FindingSeverity =
      Math.abs(delta) >= 500 ? 'high' : Math.abs(delta) >= 100 ? 'medium' : 'low';
    const direction = delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat';
    const summary =
      direction === 'flat'
        ? `Business spend held steady at ${c.spend.toFixed(2)} ${currency} (${c.count} txns).`
        : `Business spend ${direction} ${Math.abs(delta).toFixed(2)} ${currency} vs ${previousLabel} (${p.spend.toFixed(2)} -> ${c.spend.toFixed(2)} ${currency}).`;
    out.push({
      id: `business_summary-${currency}`,
      kind: 'business_summary',
      title: `Business spend ${direction === 'flat' ? 'unchanged' : direction}: ${c.spend.toFixed(2)} ${currency}`,
      summary,
      currency,
      monthlyImpact: delta,
      severity: sev,
      supportingTransactionIds: [],
      transactionFilter: {
        dateFrom: bounds.from,
        dateTo: bounds.to,
        businessOnly: true,
        currency,
      },
      meta: {
        currentSpend: c.spend,
        previousSpend: p.spend,
        currentCount: c.count,
        previousCount: p.count,
      },
    });
  }
  return out.sort((a, b) => a.currency.localeCompare(b.currency));
}

export function explainMonth(input: ExplainMonthInput): ExplainMonthResult {
  const month = input.month;
  const previous = previousMonth(month);
  const threshold = input.missingReceiptThreshold ?? DEFAULT_MISSING_RECEIPT_THRESHOLD;
  const spendChangeLimit = input.spendChangeLimit ?? DEFAULT_SPEND_CHANGE_LIMIT;

  const monthOverMonth = buildMonthOverMonth(
    input.currentTxns,
    input.previousTxns,
    input.currency ?? null,
  );

  const findings: Finding[] = [
    ...spendChangeFindings(monthOverMonth, month, previous, spendChangeLimit),
    ...subscriptionChangeFindings(input.subscriptions, month, input.currency ?? null),
    ...missingReceiptFindings(input.currentTxns, input.currency ?? null, threshold),
    ...reviewNeededFindings(input.currentTxns, month, input.currency ?? null),
    ...businessSummaryFindings(
      input.currentTxns,
      input.previousTxns,
      month,
      previous,
      input.currency ?? null,
    ),
  ];

  return {
    month,
    previousMonth: previous,
    monthOverMonth,
    findings,
    aiSummary: null,
  };
}
