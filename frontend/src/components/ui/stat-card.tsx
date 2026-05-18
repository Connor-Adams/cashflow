import * as React from 'react'
import { cn } from '@/lib/utils'
import { Card } from './card'

type StatCardProps = React.ComponentProps<typeof Card> & {
  label: React.ReactNode
  value: React.ReactNode
  hint?: React.ReactNode
  delta?: React.ReactNode
}

function parseDeltaSign(delta: React.ReactNode): 'positive' | 'negative' | 'neutral' {
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

const DELTA_SIGN_STYLE: Record<
  'positive' | 'negative' | 'neutral',
  React.CSSProperties
> = {
  positive: {
    background: 'color-mix(in srgb, var(--accent-green) 16%, transparent)',
    borderColor: 'color-mix(in srgb, var(--accent-green) 45%, var(--border))',
    color: 'var(--accent-green)',
  },
  negative: {
    background: 'color-mix(in srgb, var(--danger) 14%, transparent)',
    borderColor: 'color-mix(in srgb, var(--danger) 45%, var(--border))',
    color: 'var(--danger)',
  },
  neutral: {
    background: 'transparent',
    borderColor: 'var(--border)',
    color: 'var(--muted-foreground)',
  },
}

function StatCard({ label, value, hint, delta, className, ...props }: StatCardProps) {
  const sign = parseDeltaSign(delta)
  return (
    <Card data-slot="stat-card" className={cn('mb-0', className)} {...props}>
      <p className="statLabel">{label}</p>
      <p className={cn('statValue', 'text-3xl font-semibold')}>{value}</p>
      {hint ? (
        <p className={cn('muted statHint', 'text-xs')}>{hint}</p>
      ) : null}
      {delta ? (
        <p className="statDelta m-0">
          <span
            data-slot="stat-card-delta"
            data-sign={sign}
            className="inline-flex items-center rounded-md border px-1.5 py-0.5 text-xs font-semibold"
            style={DELTA_SIGN_STYLE[sign]}
          >
            {delta}
          </span>
        </p>
      ) : null}
    </Card>
  )
}

export { StatCard }
