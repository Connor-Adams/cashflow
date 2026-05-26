/**
 * FX-fee heuristic.
 *
 * Detects likely foreign-exchange or currency-conversion fees on a single
 * transaction using two independent signals:
 *
 *   1. Explicit text markers in merchant_raw, merchant_clean, or notes —
 *      "FX FEE", "FOREIGN", "CURRENCY CONVERSION", "EXCHANGE RATE",
 *      "NON-CAD", "INTERNATIONAL TXN", and close variants. High confidence.
 *
 *   2. Soft heuristic: small-magnitude amount AND txn currency differs from
 *      the account's default currency. Banks often post the fee as a tiny
 *      same-currency-as-account line, but on accounts where the bank posts
 *      the fee in the foreign currency this pattern catches it. Medium
 *      confidence — false-positive risk on micro transfers.
 *
 * Pure function — no DB, no network. Designed to run cheaply over every
 * transaction in scope so route handlers can stream-flag.
 */

const HIGH_CONFIDENCE_PATTERNS: ReadonlyArray<{ regex: RegExp; tag: string }> = [
  { regex: /\bfx\s*fee\b/i, tag: 'fx_fee_text' },
  { regex: /\bforeign\s*(currency|exchange|transaction|txn)\b/i, tag: 'foreign_text' },
  { regex: /\bforeign\s*transaction\s*fee\b/i, tag: 'foreign_txn_fee' },
  { regex: /\bcurrency\s*conversion\b/i, tag: 'currency_conversion' },
  { regex: /\bexchange\s*rate\b/i, tag: 'exchange_rate' },
  { regex: /\bnon[\s-]?cad\b/i, tag: 'non_cad' },
  { regex: /\binternational\s*(txn|fee|purchase)\b/i, tag: 'international_txn' },
  { regex: /\bcross[-\s]?border\s*fee\b/i, tag: 'cross_border_fee' },
];

/** Threshold below which a currency-mismatch txn is suspicious as a possible fee. */
const SMALL_AMOUNT_THRESHOLD = 5;

export interface DetectFxFeeInput {
  merchantRaw: string | null | undefined;
  merchantClean: string | null | undefined;
  notes: string | null | undefined;
  amount: number;
  currency: string;
  /** The default currency of the parent account. May be null for legacy rows. */
  accountDefaultCurrency: string | null | undefined;
}

export interface DetectFxFeeResult {
  isFxFee: boolean;
  /** Why we flagged (or null when we didn't). */
  reason: string | null;
  /** 'high' when explicit text matched, 'medium' for soft heuristics. */
  confidence: 'high' | 'medium' | 'low' | null;
}

/**
 * Concatenate the user-facing text fields into a single search corpus.
 * Returns lowercase for case-insensitive matching.
 */
function buildCorpus(input: DetectFxFeeInput): string {
  return [input.merchantRaw ?? '', input.merchantClean ?? '', input.notes ?? '']
    .join(' ')
    .toLowerCase();
}

function detectByText(input: DetectFxFeeInput): { tag: string } | null {
  const corpus = buildCorpus(input);
  if (corpus.trim().length === 0) return null;
  for (const { regex, tag } of HIGH_CONFIDENCE_PATTERNS) {
    if (regex.test(corpus)) return { tag };
  }
  return null;
}

/**
 * Heuristic fallback: small-magnitude txn whose currency differs from the
 * account's default currency. Useful for posts like "Bank Adjustment $1.50 USD"
 * on a CAD chequing account where the bank doesn't tag the row with explicit
 * fee text but the shape gives it away.
 */
function detectByShape(input: DetectFxFeeInput): boolean {
  if (!input.accountDefaultCurrency) return false;
  if (input.currency === input.accountDefaultCurrency) return false;
  return Math.abs(input.amount) < SMALL_AMOUNT_THRESHOLD;
}

export function detectFxFee(input: DetectFxFeeInput): DetectFxFeeResult {
  const textHit = detectByText(input);
  if (textHit) {
    return {
      isFxFee: true,
      reason: `text_match:${textHit.tag}`,
      confidence: 'high',
    };
  }

  if (detectByShape(input)) {
    return {
      isFxFee: true,
      reason: 'shape:small_cross_currency_amount',
      confidence: 'medium',
    };
  }

  return { isFxFee: false, reason: null, confidence: null };
}
