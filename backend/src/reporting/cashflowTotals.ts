import { num } from '../util/numbers';
import { isNonSpend } from '../summary/classifyTransactionFlow';

/**
 * Minimal transaction shape the reporting cashflow summary needs. Mirrors the
 * `Transaction.findAll({ attributes: ['amount', 'txnType', 'finalCategory'] })`
 * projections in the reporting routes.
 */
export type ReportingTxnRow = {
  amount: unknown;
  txnType: string | null;
  finalCategory?: string | null;
  accountType?: string | null;
};

export type ReportingCashflowTotals = {
  /** Gross spend: |negative amounts| that are NOT money-movement / non-spend. */
  totalSpend: number;
  /** Real income only: positive rows whose txnType is 'income'. */
  totalIncome: number;
  /** Subset of totalSpend whose finalCategory is in `essentialCategories`. */
  essentialSpend: number;
};

/**
 * Classify a set of reporting transactions into spend / income / essential
 * spend, using the SAME rules as the dashboard aggregator so the reporting API
 * (/summary, /forecast, /runway) reconciles with the dashboard:
 *
 *  - A NEGATIVE amount counts as spend only when `isNonSpend` is false — i.e.
 *    transfers, investment buys, statement payments, refunds-reversals, etc. are
 *    excluded from burn (previously every negative inflated burn).
 *  - A POSITIVE amount counts as income only when `txnType === 'income'` — the
 *    same peel the dashboard applies. Refunds, rewards, and untyped deposits are
 *    NOT income (previously every positive that wasn't a payment/transfer bled
 *    into income, inflating savings rate and runway).
 *
 * `essentialCategories` is optional; pass it (lower-cased keys) to also bucket
 * essential spend for runway. Values are matched case-insensitively.
 */
export function summarizeReportingCashflow(
  rows: ReportingTxnRow[],
  essentialCategories?: ReadonlySet<string>,
): ReportingCashflowTotals {
  let totalSpend = 0;
  let totalIncome = 0;
  let essentialSpend = 0;

  for (const row of rows) {
    const amount = num(row.amount);
    if (amount == null) continue;

    if (amount < 0) {
      if (isNonSpend(row.txnType, row.accountType ?? null)) continue;
      const abs = Math.abs(amount);
      totalSpend += abs;
      if (essentialCategories) {
        const cat = (row.finalCategory ?? '').toLowerCase();
        if (essentialCategories.has(cat)) essentialSpend += abs;
      }
    } else if (row.txnType === 'income') {
      totalIncome += amount;
    }
    // Other positives (refund / reward / payment / transfer / unknown deposits)
    // are neither spend nor income for reporting purposes — intentionally
    // excluded from both totals.
  }

  return { totalSpend, totalIncome, essentialSpend };
}
