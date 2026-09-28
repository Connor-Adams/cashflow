/**
 * Types for `merchantNormalization.js`. See that file for why the
 * implementation is plain CommonJS outside `src/`.
 */

/**
 * Remove transaction-specific boilerplate from an already-whitespace-collapsed
 * merchant string: a trailing `[<CURRENCY WORDS> <amount> @ <rate>]` FX
 * annotation, a clause carrying an embedded ISO date, and a card-network
 * purchase prefix with its per-transaction terminal reference.
 *
 * Pure and total: never throws, and never returns an empty string when the
 * input was non-empty (a row whose merchant is nothing *but* boilerplate keeps
 * the boilerplate, so it still has something to key on).
 */
export function stripTransactionBoilerplate(input: string): string;

/**
 * Canonicalise a raw merchant string into the `merchant_clean` key that
 * merchant memory and Rule patterns match on. Strips processor prefixes, store
 * numbers, phone numbers, city/state/country tails, duplicated tail words and
 * the transaction-specific boilerplate above.
 */
export function normalizeMerchant(raw: unknown): string;
