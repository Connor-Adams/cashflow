import type * as React from 'react'

// Semantic intent of the metric a delta belongs to. Drives how the delta
// color is chosen: for spend metrics, less is good, so a positive (up) delta
// reads as bad (red). For gain metrics, more is good, so up reads as green.
// Neutral metrics (transfers, row counts) never color the delta because the
// direction isn't inherently good or bad.
export type MetricKind = 'gain' | 'spend' | 'neutral'

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

// Map the parsed numeric sign + the metric's semantic intent to the styling
// tone. For 'gain' metrics the sign and tone agree (up is good → green). For
// 'spend' metrics the tone is inverted (up is bad → red). For 'neutral'
// metrics every delta renders muted regardless of sign — the direction is
// directionally meaningful but not emotionally good or bad.
export function resolveDeltaTone(sign: DeltaSign, kind: MetricKind): DeltaTone {
  if (kind === 'neutral') return 'neutral'
  if (sign === 'neutral') return 'neutral'
  if (kind === 'spend') {
    return sign === 'positive' ? 'negative' : 'positive'
  }
  return sign
}

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
