export function formatCurrency(amount: number, currencyCode: string): string {
  const code = (currencyCode ?? '').trim().toUpperCase().slice(0, 3)
  if (code.length !== 3) return String(amount)
  try {
    return new Intl.NumberFormat('en-CA', {
      style: 'currency',
      currency: code,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(amount)
  } catch {
    return String(amount)
  }
}
