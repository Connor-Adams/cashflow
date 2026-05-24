/**
 * Compare an OCR-extracted receipt note against the transaction it was
 * matched to, and return a list of human-readable warnings when fields
 * disagree. Used by the `/api/transactions` listing route to surface
 * "receipt looks off" badges next to a transaction without blocking the
 * read path.
 *
 * Pure, side-effect free, and tolerant of garbage input: any JSON parse
 * failure on `extractedNote` produces a single "could not be read" warning
 * rather than throwing.
 */
export function computeReceiptWarnings(
  extractedNote: string,
  txn: { amount: unknown; currency: string; date: string }
): string[] {
  try {
    const extracted = JSON.parse(extractedNote) as {
      total?: unknown;
      currency?: unknown;
      date?: unknown;
    };
    const warnings: string[] = [];
    const receiptTotal = Number(extracted.total);
    const txnAmountAbs = Math.abs(Number(txn.amount));
    if (
      Number.isFinite(receiptTotal) &&
      Number.isFinite(txnAmountAbs) &&
      Math.abs(receiptTotal - txnAmountAbs) > 0.02
    ) {
      warnings.push('receipt total differs');
    }
    if (
      typeof extracted.currency === 'string' &&
      extracted.currency.toUpperCase() !== txn.currency
    ) {
      warnings.push('receipt currency differs');
    }
    if (typeof extracted.date === 'string' && extracted.date !== txn.date) {
      warnings.push('receipt date differs');
    }
    return warnings;
  } catch {
    return ['receipt extract could not be read'];
  }
}
