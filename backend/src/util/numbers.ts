/**
 * SQLite DECIMAL values often arrive as strings on reads.
 */
export function num(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isNaN(n) ? null : n;
}
