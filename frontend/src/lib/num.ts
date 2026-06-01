/**
 * Numeric safety helpers for render paths that receive potentially non-finite
 * values from the backend (null coerced to NaN, 0/0, etc.).
 */

export function safeNum(n: unknown): number | null {
  if (typeof n === 'number' && Number.isFinite(n)) return n
  if (typeof n === 'string') {
    const parsed = Number(n)
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

export function clampPct(n: unknown): number {
  const v = safeNum(n)
  if (v === null) return 0
  return Math.min(100, Math.max(0, v))
}

export function safePct(
  n: unknown,
  opts?: { digits?: number; fallback?: string; clamp?: boolean },
): string {
  const fallback = opts?.fallback ?? '—'
  const digits = opts?.digits ?? 1
  const shouldClamp = opts?.clamp !== false
  const v = safeNum(n)
  if (v === null) return fallback
  if (process.env.NODE_ENV !== 'production' && (v < 0 || v > 100)) {
    console.warn(`safePct: value ${v} out of [0, 100] range, clamping`)
  }
  const clamped = shouldClamp ? Math.min(100, Math.max(0, v)) : v
  return `${clamped.toFixed(digits)}%`
}
