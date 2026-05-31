export function safePct(n: unknown, opts?: { digits?: number; fallback?: string; clamp?: boolean }): string {
  const digits = opts?.digits ?? 1
  const fallback = opts?.fallback ?? '—'
  const clamp = opts?.clamp ?? true
  if (!Number.isFinite(Number(n))) return fallback
  const v = clamp ? Math.min(100, Math.max(0, Number(n))) : Number(n)
  if (clamp && Number(n) > 100 && typeof process !== 'undefined' && process.env?.NODE_ENV === 'development') {
    console.warn('[safePct] value clamped:', n)
  }
  return `${v.toFixed(digits)}%`
}
export function safeNum(n: unknown): number | null {
  const v = Number(n)
  return Number.isFinite(v) ? v : null
}
export function clampPct(n: unknown): number {
  const v = Number(n)
  if (!Number.isFinite(v)) return 0
  return Math.min(100, Math.max(0, v))
}
