import { formatCurrency } from './formatCurrency'

/**
 * Format a numeric amount with an ISO 4217 currency code.
 *
 * Single source of truth: delegates to {@link formatCurrency}, which pins the
 * `en-CA` locale with fixed 2-decimal fractions. This keeps every call site
 * (68 and counting) rendering identically — `$1,234.56` — regardless of the
 * viewer's system locale. Falls back to `String(amount)` for an invalid code.
 */
export function formatMoney(amount: number, currencyCode?: string): string {
  return formatCurrency(amount, currencyCode ?? '')
}

/**
 * Null-aware money formatter. Returns `placeholder` (default `—`) when the
 * amount is `null`, `undefined`, or `NaN`, so missing data is never masked as a
 * misleading `$0.00`. A genuine `0` still renders `$0.00`.
 */
export function formatMoneyOr(
  amount: number | null | undefined,
  currencyCode?: string,
  placeholder = '—'
): string {
  if (amount == null || Number.isNaN(amount)) return placeholder
  return formatMoney(amount, currencyCode)
}
