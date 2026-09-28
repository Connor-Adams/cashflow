/**
 * Types for `merchantNormalization.js`. See that file for why the
 * implementation is plain CommonJS outside `src/`.
 */

/**
 * Canonicalise a raw merchant string into the `merchant_clean` key that
 * merchant memory and Rule patterns match on. Strips processor prefixes, store
 * numbers, phone numbers, city/state/country tails, duplicated tail words and
 * the transaction-specific boilerplate above.
 */
export function normalizeMerchant(raw: unknown): string;
