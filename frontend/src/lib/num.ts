/**
 * Numeric safety helpers for render paths that receive potentially non-finite
 * values (null, undefined, NaN, Infinity) from the API.
 */

function isFiniteNum(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n)
}

/**
 * Clamps a value to [0, 100] and returns a formatted percentage string.
 * Returns `fallback` (default `'—'`) when `n` is not a finite number.
 */
export function safePct(
  n: unknown,
  opts?: { digits?: number; fallback?: string; clamp?: boolean },
): string {
  const fallback = opts?.fallback ?? '—'
  const digits = opts?.digits ?? 1
  const shouldClamp = opts?.clamp !== false
  if (!isFiniteNum(n)) return fallback
  const v = shouldClamp ? Math.min(100, Math.max(0, n)) : n
  if (shouldClamp && process.env.NODE_ENV !== 'production' && (n < 0 || n > 100)) {
    console.warn(`safePct: value ${n} clamped to [0, 100]`)
  }
  return `${v.toFixed(digits)}%`
}

/**
 * Returns `n` if it is a finite number, otherwise `null`.
 */
export function safeNum(n: unknown): number | null {
  return isFiniteNum(n) ? n : null
}

/**
 * Clamps a value to [0, 100] and returns the clamped number.
 * Returns `0` when `n` is not finite.
 */
export function clampPct(n: unknown): number {
  if (!isFiniteNum(n)) return 0
  return Math.min(100, Math.max(0, n))
}
