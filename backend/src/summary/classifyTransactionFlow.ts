export type PositiveFlowKind = 'payment' | 'credit';
export type PositiveBucket = 'payment' | 'credit' | 'skip';

const PAYMENT_PATTERNS = [
  /\bonline payment\b/,
  /\bpayment received\b/,
  /\bpayment thank you\b/,
  /\bautopay\b/,
  /\bauto pay\b/,
  /\btransfer\b/,
  /\be-?transfer\b/,
  /\bach\b/,
  /\bbill payment\b/,
  /\bweb payment\b/,
  /\bpre-authorized payment\b/,
  /\bpayment\b/,
];

const CREDIT_PATTERNS = [
  /\brefund\b/,
  /\breturn(?:ed)?\b/,
  /\breversal\b/,
  /\bstatement credit\b/,
  /\breward\b/,
  /\bcash ?back\b/,
  /\badjustment\b/,
  /\breimbursement\b/,
];

/**
 * Transaction.txnType values that DO NOT contribute to spend totals.
 *
 * Includes money-movement flows (transfer/investment/dividend), statement
 * payments, refunds, rewards, and historical income. `purchase`, `fee`,
 * `interest`, `unknown`, and null still count as spend so legitimate
 * negative-amount transactions aren't silently lost.
 */
export const NON_SPEND_TXN_TYPES: ReadonlySet<string> = new Set([
  'transfer',
  'investment',
  'dividend',
  'payment',
  'refund',
  'reward',
  'income',
]);

/**
 * Subset of NON_SPEND_TXN_TYPES that should ALSO be excluded from the
 * by-category / by-month / by-split / by-business breakdowns AND from the
 * headline positive-amount aggregation. These rows represent money flows
 * that don't belong to any spend category and aren't a credit against one
 * (you can't categorize a brokerage BUY as "Groceries" and a positive
 * AFT_IN deposit isn't a refund). Refunds, rewards, and statement credits
 * stay categorical because they net against category spend meaningfully.
 */
export const NON_CATEGORICAL_TXN_TYPES: ReadonlySet<string> = new Set([
  'transfer',
  'investment',
  'dividend',
]);

/** True when a row's amount must not contribute to spend totals. */
export function isNonSpend(
  txnType: string | null | undefined,
  accountType: string | null | undefined,
): boolean {
  if (txnType && NON_SPEND_TXN_TYPES.has(txnType)) return true;
  if (accountType === 'investment') return true;
  return false;
}

/** True when a row is purely money-movement / brokerage flow with no category. */
export function isNonCategorical(
  txnType: string | null | undefined,
  accountType: string | null | undefined,
): boolean {
  if (txnType && NON_CATEGORICAL_TXN_TYPES.has(txnType)) return true;
  if (accountType === 'investment') return true;
  return false;
}

function normalizeText(parts: Array<string | null | undefined>): string {
  return parts
    .filter((part) => part != null && part !== '')
    .join(' ')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Merchant-text-only classifier. Used as a fallback when txnType is missing
 * or ambiguous. Returns 'credit' by default.
 */
export function classifyPositiveFlow(input: {
  merchantRaw?: string | null;
  merchantClean?: string | null;
  category?: string | null;
}): PositiveFlowKind {
  const text = normalizeText([
    input.merchantRaw,
    input.merchantClean,
    input.category,
  ]);
  if (!text) return 'credit';
  // Refund/reversal/credit signals are explicit user-money-back intent and
  // override payment-substring matches like /\bpayment\b/. A row "PAYMENT
  // REVERSAL" matches both pattern sets — the reversal must win.
  if (CREDIT_PATTERNS.some((re) => re.test(text))) return 'credit';
  if (PAYMENT_PATTERNS.some((re) => re.test(text))) return 'payment';
  return 'credit';
}

/**
 * Authoritative router for a positive-amount row's contribution to the
 * dashboard's three positive buckets: totalPayments, totalCredits, or
 * none-of-the-above ('skip', for transfer/investment/dividend flows that
 * aren't consumption, refund, or income in any meaningful sense).
 *
 * Resolution order:
 *   1. Investment account or non-categorical txnType → 'skip'
 *      (matches the negative-side `isNonCategorical` filter so the headline
 *       reconciles with the per-category breakdowns).
 *   2. txnType='payment' → 'payment' (statement payment landing positive).
 *   3. txnType ∈ {refund, reward, income} → 'credit' (intent is explicit).
 *   4. Else → merchant-text fallback via classifyPositiveFlow.
 */
export function classifyPositiveAmount(input: {
  txnType?: string | null;
  accountType?: string | null;
  merchantRaw?: string | null;
  merchantClean?: string | null;
  category?: string | null;
}): PositiveBucket {
  if (isNonCategorical(input.txnType, input.accountType)) return 'skip';
  if (input.txnType === 'payment') return 'payment';
  if (
    input.txnType === 'refund' ||
    input.txnType === 'reward' ||
    input.txnType === 'income'
  ) {
    return 'credit';
  }
  return classifyPositiveFlow(input);
}
