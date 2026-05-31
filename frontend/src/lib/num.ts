/** Returns `n` if it is a finite number, otherwise `null`. */
export function safeNum(n: unknown): number | null {
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

/**
 * Clamps a numeric value to [0, 100].
 * Returns 0 for non-finite or non-numeric inputs.
 */
export function clampPct(n: unknown): number {
  const v = safeNum(n);
  if (v === null) return 0;
  return Math.min(100, Math.max(0, v));
}

/**
 * Formats a percentage value safely.
 * Returns `fallback` (default '—') when `n` is not a finite number.
 * Clamps the value to [0, 100] before formatting by default.
 */
export function safePct(
  n: unknown,
  opts?: { digits?: number; fallback?: string; clamp?: boolean },
): string {
  const v = safeNum(n);
  if (v === null) return opts?.fallback ?? '—';
  const digits = opts?.digits ?? 1;
  const shouldClamp = opts?.clamp !== false;
  const display = shouldClamp ? clampPct(v) : v;
  return `${display.toFixed(digits)}%`;
}
