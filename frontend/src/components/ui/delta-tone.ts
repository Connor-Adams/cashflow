import type * as React from 'react'
import { resolveDeltaTone, type MetricKind } from '@connor-adams/designsystem'

// The metric-semantics core (`MetricKind` + `resolveDeltaTone`) now lives in the
// design system — re-export it so app code keeps a single import surface. The
// pieces below are genuinely app-local: the DS StatCard parses the delta sign and
// styles its own badge, but the app's DeltaBadge / TopGrowersTile render badges
// from numeric deltas, so they still need `parseDeltaSign` and the shared
// `DELTA_SIGN_STYLE` (which the DS does not export).
export { resolveDeltaTone, type MetricKind }

export type DeltaSign = 'positive' | 'negative' | 'neutral'
export type DeltaTone = 'positive' | 'negative' | 'neutral'

export function parseDeltaSign(delta: React.ReactNode): DeltaSign {
  if (delta == null) return 'neutral'
  const text = typeof delta === 'string' || typeof delta === 'number' ? String(delta) : ''
  if (!text) return 'neutral'
  const trimmed = text.trim()
  // Find the first explicit sign that introduces a numeric chunk, tolerating
  // a leading descriptor (e.g. "vs previous period: ") and currency symbols
  // between the sign and the digits.
  const signMatch = trimmed.match(/([+\-−])\s*[^\d+\-−]*\d/)
  if (signMatch) {
    return signMatch[1] === '+' ? 'positive' : 'negative'
  }
  // No explicit sign — fall back to coercing the first numeric token.
  const match = trimmed.match(/\d+(\.\d+)?/)
  if (!match) return 'neutral'
  const num = Number(match[0])
  if (!Number.isFinite(num) || num === 0) return 'neutral'
  return num > 0 ? 'positive' : 'negative'
}

// A CSSProperties lookup (not JSX className context) — each tone pairs a
// color-mix tint with its base token, so the whole object stays inline var().
export const DELTA_SIGN_STYLE: Record<DeltaTone, React.CSSProperties> = {
  positive: {
    background: 'color-mix(in srgb, var(--positive) 16%, transparent)',
    borderColor: 'color-mix(in srgb, var(--positive) 45%, var(--border))',
    color: 'var(--positive)',
  },
  negative: {
    background: 'color-mix(in srgb, var(--destructive) 14%, transparent)',
    borderColor: 'color-mix(in srgb, var(--destructive) 45%, var(--border))',
    color: 'var(--destructive)',
  },
  neutral: {
    background: 'transparent',
    borderColor: 'var(--border)',
    color: 'var(--muted-foreground)',
  },
}
