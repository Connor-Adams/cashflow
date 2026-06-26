/**
 * Normalize a transaction source reference for storage and dedup.
 *
 * Strips surrounding single/double quotes (an import quirk — some statement
 * parsers wrapped the reference in literal quotes) and trims whitespace, so a
 * quoted `'AT26'` and a bare `AT26` collapse to the same value. Empty or
 * quotes-only input becomes null. Quotes that are not a surrounding pair are
 * left intact.
 */
export function normalizeSourceRef(v: string | null | undefined): string | null {
  if (v == null) return null;
  let s = v.trim();
  while (
    s.length >= 2 &&
    ((s[0] === "'" && s[s.length - 1] === "'") ||
      (s[0] === '"' && s[s.length - 1] === '"'))
  ) {
    s = s.slice(1, -1).trim();
  }
  return s === '' ? null : s;
}
