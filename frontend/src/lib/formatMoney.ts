/** Format a numeric amount with ISO 4217 currency code; falls back if invalid. */
export function formatMoney(amount: number, currencyCode: string): string {
  const code = currencyCode.trim().toUpperCase().slice(0, 3)
  if (code.length !== 3) return String(amount)
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: code,
    }).format(amount)
  } catch {
    return String(amount)
  }
}
