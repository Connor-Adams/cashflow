export function normalizeMerchant(raw: unknown): string {
  if (raw == null) return '';
  return String(raw)
    .trim()
    .replace(/\s+/g, ' ');
}
