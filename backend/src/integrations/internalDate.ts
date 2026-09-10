/**
 * Gmail hands every message an `internalDate` (ms since epoch) that we already
 * fetch but have never used. Amazon sends order confirmations within minutes of
 * the order, so the email's own date is a near-exact order date — and unlike the
 * body, it is always present. See
 * docs/superpowers/specs/2026-09-10-amazon-email-matching-design.md.
 */
export function dateFromInternalDate(
  internalDate: string | null | undefined,
): string | null {
  if (internalDate == null || internalDate === '') return null;
  const ms = Number(internalDate);
  if (!Number.isFinite(ms)) return null;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return null;
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
