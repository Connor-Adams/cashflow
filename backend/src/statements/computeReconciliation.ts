/**
 * Pure reconciliation math for statement reconciliation (#242).
 *
 * Given a statement's opening/closing balance and the transactions that
 * fall inside the statement period for the same account, compute:
 *
 *   expectedClosing = openingBalance + sum(amounts)
 *   variance        = reportedClosing - expectedClosing
 *
 * `transactions` MUST already be filtered to the statement's account and
 * period window; this helper performs no additional filtering. The caller
 * (route layer) is responsible for the SQL filter so the math stays a
 * pure function suitable for fast unit testing.
 *
 * Why this avoids the "internal transfers / refunds double-count" pitfall
 * called out in the issue's AC:
 *
 *  - Each transaction belongs to exactly ONE account. A transfer from
 *    Chequing → Savings is stored as two rows: one negative on Chequing,
 *    one positive on Savings. When the user reconciles the Chequing
 *    statement, only the Chequing row is summed — the matching Savings
 *    row is on a different account and is excluded by the route's WHERE.
 *  - A refund is just another transaction on the same account with the
 *    opposite sign of the original purchase. Both rows contribute to the
 *    sum exactly once, which is correct.
 *
 * So the math is straight arithmetic on per-account transaction rows;
 * there is no special-case logic for transfer or refund classification.
 *
 * Returns DECIMAL-style strings rounded to 4 places to match the
 * `DECIMAL(18,4)` precision used everywhere else in the codebase.
 */

export type ReconciliationTransaction = {
  amount: number | string;
};

export type ReconciliationResult = {
  expectedClosing: number;
  variance: number;
  transactionCount: number;
  transactionTotal: number;
};

/**
 * Coerce a Sequelize DECIMAL (string) or plain number to a finite number.
 * Returns 0 for null/undefined/NaN so callers don't need to defensively
 * guard against missing fields on partially-loaded rows.
 */
function toNumber(v: unknown): number {
  if (v == null) return 0;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Round to 4 decimal places to match DECIMAL(18,4). */
function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

export function computeReconciliation(args: {
  openingBalance: number | string;
  closingBalance: number | string;
  transactions: ReadonlyArray<ReconciliationTransaction>;
}): ReconciliationResult {
  const opening = toNumber(args.openingBalance);
  const reportedClosing = toNumber(args.closingBalance);
  let txnTotal = 0;
  for (const t of args.transactions) {
    txnTotal += toNumber(t.amount);
  }
  const expectedClosing = round4(opening + txnTotal);
  const variance = round4(reportedClosing - expectedClosing);
  return {
    expectedClosing,
    variance,
    transactionCount: args.transactions.length,
    transactionTotal: round4(txnTotal),
  };
}

/**
 * Variance tolerance for "matches" classification.
 * One cent — anything smaller is noise from rounding.
 */
export const VARIANCE_TOLERANCE = 0.01;

/** True when the statement's reported closing matches expectedClosing. */
export function isBalanced(result: ReconciliationResult): boolean {
  return Math.abs(result.variance) <= VARIANCE_TOLERANCE;
}
