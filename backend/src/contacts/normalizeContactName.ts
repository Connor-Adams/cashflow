/**
 * Canonical contact-name normalization key: lowercase + whitespace-collapsed.
 * Used by the Contact `normalized_name` column/hook AND the counterparty
 * promotion matcher so import-created and promote-matched contacts dedupe
 * identically. Returns null for empty/whitespace input.
 */
export function normalizeContactName(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const trimmed = String(raw).trim().toLowerCase().replace(/\s+/g, ' ');
  return trimmed === '' ? null : trimmed;
}
