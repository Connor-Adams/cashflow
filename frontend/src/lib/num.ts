/**
 * Returns `fallback` when `n` is not a finite number; otherwise formats it as
 * a percentage string, clamped to [0, 100] by default.
 */
export function safePct(
  n: unknown,
  opts?: { digits?: number; fallback?: string; clamp?: boolean },
): string {
  const digits = opts?.digits ?? 1
  const fallback = opts?.fallback ?? '—'
  const clamp = opts?.clamp !== false

  if (typeof n !== 'number' || !Number.isFinite(n)) return fallback

  if (process.env.NODE_ENV !== 'production' && clamp && (n > 100 || n < 0)) {
    console.warn(`[num] safePct: value ${n} clamped to [0, 100]`)
  }

  const val = clamp ? Math.min(100, Math.max(0, n)) : n
  return `${val.toFixed(digits)}%`
}

/**
 * Returns `n` as a number if it is finite, otherwise `null`.
 * Accepts strings and coerces them first.
 */
export function safeNum(n: unknown): number | null {
  if (typeof n === 'number') return Number.isFinite(n) ? n : null
  if (typeof n === 'string') {
    const parsed = Number(n)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

/**
 * Returns a number clamped to [0, 100], or 0 if `n` is not finite.
 */
export function clampPct(n: unknown): number {
  const num = typeof n === 'number' ? n : Number(n)
  if (!Number.isFinite(num)) return 0
  return Math.min(100, Math.max(0, num))
}
