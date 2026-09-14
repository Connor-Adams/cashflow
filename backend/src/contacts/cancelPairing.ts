/**
 * Interac e-transfer cancellations. RBC writes the original as
 * `E-TRANSFER SENT <NAME> <CODE>` (or `E-TRANSFER REQUEST FULFILLED ...`) and
 * the reversal as `E-TRANSFER CANCEL <NAME> <CODE>`, sharing a confirmation
 * code. Counting the reversal as an inflow reads as a repayment that never
 * happened, so both legs are excluded from the balance.
 *
 * A cancel with no matching original is deliberately NOT excluded: without its
 * pair we cannot tell a reversal from a real inbound transfer, and dropping it
 * would hide money.
 */

/** Trailing alphanumeric confirmation code, at least 5 chars. */
const CODE = /\b([A-Z0-9]{5,})\s*$/;

function codeOf(text: string | null, marker: RegExp): string | null {
  if (!text) return null;
  const upper = text.toUpperCase();
  if (!marker.test(upper)) return null;
  const m = CODE.exec(upper.trim());
  return m ? m[1] : null;
}

const CANCEL = /E-?TRANSFER\s+CANCEL/;
const ORIGINAL = /E-?TRANSFER\s+(SENT|REQUEST FULFILLED)/;

export function findCancelledTransferIds(
  rows: Array<{ id: number; merchantText: string | null }>,
): Set<number> {
  const cancelsByCode = new Map<string, number[]>();
  const originalsByCode = new Map<string, number[]>();

  for (const r of rows) {
    const cancelCode = codeOf(r.merchantText, CANCEL);
    if (cancelCode) {
      const list = cancelsByCode.get(cancelCode) ?? [];
      list.push(r.id);
      cancelsByCode.set(cancelCode, list);
      continue;
    }
    const originalCode = codeOf(r.merchantText, ORIGINAL);
    if (originalCode) {
      const list = originalsByCode.get(originalCode) ?? [];
      list.push(r.id);
      originalsByCode.set(originalCode, list);
    }
  }

  const out = new Set<number>();
  for (const [code, cancelIds] of cancelsByCode) {
    const originalIds = originalsByCode.get(code);
    if (!originalIds || originalIds.length === 0) continue;
    for (const id of cancelIds) out.add(id);
    for (const id of originalIds) out.add(id);
  }
  return out;
}
