/**
 * Interac e-transfer cancellations. RBC writes the original as
 * `E-TRANSFER SENT <NAME> <CODE>` (or `E-TRANSFER REQUEST FULFILLED ...`) and
 * the reversal as `E-TRANSFER CANCEL <NAME> <CODE>`, sharing a confirmation
 * code. Counting the reversal as an inflow reads as a repayment that never
 * happened, so both legs are excluded from the balance.
 *
 * The trailing "code" is just the last run of 5+ alphanumeric characters, so a
 * plain surname (e.g. `ADCOCK`) can look exactly like a confirmation code. A
 * cancel is only paired with an original when the code has EXACTLY one
 * original and EXACTLY one cancel — a strict one-to-one match. Any other
 * count for a given code (two originals sharing it, two cancels, or a cancel
 * with no original at all) excludes NOTHING for that code: with more than one
 * candidate on either side we cannot tell which pairs with which, and a wrong
 * guess would silently drop a real, never-cancelled transfer from the
 * balance. This is the same asymmetry the module has always followed — when
 * the matcher cannot be certain, it declines to hide money — extended from
 * "no original" to "any ambiguous count".
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

const CANCEL = /E-?TRANSFER\s+CANCEL\b/;
const ORIGINAL = /E-?TRANSFER\s+(SENT|REQUEST FULFILLED)\b/;

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
    if (!originalIds || originalIds.length !== 1 || cancelIds.length !== 1) continue;
    out.add(cancelIds[0]);
    out.add(originalIds[0]);
  }
  return out;
}
