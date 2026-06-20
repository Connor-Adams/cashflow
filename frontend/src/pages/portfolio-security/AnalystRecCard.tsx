import { Card } from '@connor-adams/designsystem'
import type { PortfolioSecurityOverview } from '../../types/api'

export type AnalystRecCardProps = {
  overview: PortfolioSecurityOverview | null
}

type BucketKey = 'strongBuy' | 'buy' | 'hold' | 'sell' | 'strongSell'

const BUCKET_DEFS: Array<{ key: BucketKey; label: string; color: string }> = [
  { key: 'strongBuy', label: 'Strong Buy', color: 'var(--accent-positive)' },
  { key: 'buy', label: 'Buy', color: 'color-mix(in oklab, var(--accent-positive) 60%, var(--background))' },
  { key: 'hold', label: 'Hold', color: 'var(--muted-foreground)' },
  { key: 'sell', label: 'Sell', color: 'color-mix(in oklab, var(--accent-warm) 60%, var(--background))' },
  { key: 'strongSell', label: 'Strong Sell', color: 'var(--accent-warm)' },
]

function periodLabel(p: string | null): string {
  if (!p) return '—'
  // Yahoo emits e.g. "0m" (current), "-1m", "-2m", "-3m"
  if (p === '0m') return 'Now'
  const m = /^(-?\d+)m$/.exec(p)
  if (m) {
    const n = Number(m[1])
    if (n === 0) return 'Now'
    return `${Math.abs(n)}mo ago`
  }
  return p
}

function actionLabel(action: string | null): string {
  switch (action) {
    case 'up':
      return 'Upgrade'
    case 'down':
      return 'Downgrade'
    case 'init':
      return 'Initiated'
    case 'main':
      return 'Reiterated'
    case 'reit':
      return 'Reiterated'
    default:
      return action ?? '—'
  }
}

function actionColor(action: string | null): string | undefined {
  switch (action) {
    case 'up':
      return 'var(--accent-positive)'
    case 'down':
      return 'var(--accent-warm)'
    default:
      return undefined
  }
}

export function AnalystRecCard({ overview }: AnalystRecCardProps) {
  if (!overview) return null

  const trend = (overview.recommendationTrend ?? []).slice().reverse() // oldest → newest
  const upgrades = overview.upgradeDowngradeHistory ?? []
  if (trend.length === 0 && upgrades.length === 0) return null

  return (
    <Card>
      <div className="transactionsPanelHeader">
        <div>
          <h2 className="text-base">Analyst recommendations</h2>
          <p className="muted">Source: Yahoo Finance.</p>
        </div>
      </div>

      {trend.length > 0 && (
        <div className="mt-3">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
            Sentiment over time
          </h3>
          <div className="space-y-2">
            {trend.map((row, i) => {
              const counts: Record<BucketKey, number> = {
                strongBuy: row.strongBuy ?? 0,
                buy: row.buy ?? 0,
                hold: row.hold ?? 0,
                sell: row.sell ?? 0,
                strongSell: row.strongSell ?? 0,
              }
              const total = BUCKET_DEFS.reduce((s, b) => s + counts[b.key], 0)
              if (total === 0) return null
              return (
                <div key={`${row.period ?? i}`} className="grid grid-cols-[80px_1fr_60px] items-center gap-2 text-xs">
                  <span className="muted">{periodLabel(row.period)}</span>
                  <div className="flex h-3 overflow-hidden rounded-full bg-muted">
                    {BUCKET_DEFS.map((b) => {
                      const pct = (counts[b.key] / total) * 100
                      if (pct === 0) return null
                      return (
                        <div
                          key={b.key}
                          style={{ width: `${pct}%`, background: b.color }}
                          title={`${b.label}: ${counts[b.key]}`}
                        />
                      )
                    })}
                  </div>
                  <span className="tabular-nums text-right">{total} analysts</span>
                </div>
              )
            })}
          </div>
          <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-xs">
            {BUCKET_DEFS.map((b) => (
              <div key={b.key} className="flex items-center gap-1.5">
                <span className="inline-block size-2.5 rounded-sm" style={{ background: b.color }} />
                <span className="muted">{b.label}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {upgrades.length > 0 && (
        <div className="mt-4">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
            Recent rating changes
          </h3>
          <ul className="space-y-1.5 text-sm">
            {upgrades.slice(0, 10).map((u, i) => (
              <li
                key={`${u.date ?? i}-${u.firm ?? ''}`}
                className="grid grid-cols-[80px_1fr_auto] items-baseline gap-2"
              >
                <span className="muted text-xs">{u.date?.slice(0, 10) ?? '—'}</span>
                <span>
                  <span className="font-medium">{u.firm ?? 'Unknown'}</span>
                  {u.fromGrade && u.toGrade && (
                    <span className="muted">
                      {' '}
                      · {u.fromGrade} → {u.toGrade}
                    </span>
                  )}
                  {!u.fromGrade && u.toGrade && <span className="muted"> · {u.toGrade}</span>}
                </span>
                <span
                  className="text-xs font-medium"
                  style={{ color: actionColor(u.action) }}
                >
                  {actionLabel(u.action)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  )
}
