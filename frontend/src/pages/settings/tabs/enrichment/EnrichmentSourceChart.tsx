import { Link } from 'react-router-dom'
import { Card } from '@connor-adams/designsystem'
import { enrichmentFilterHref } from './enrichmentFilterHref'

const SOURCE_COLOR: Record<string, string> = {
  rules: 'var(--chart-2)',
  ai: 'var(--chart-3)',
  manual: 'var(--chart-5)',
  '(none)': 'var(--border)',
}

const LABEL: Record<string, string> = {
  '(none)': 'none',
}

type Props = {
  bySource: Record<string, number>
}

export function EnrichmentSourceChart({ bySource }: Props) {
  const entries = Object.entries(bySource).sort((a, b) => b[1] - a[1])
  const total = entries.reduce((acc, [, n]) => acc + n, 0)

  return (
    <Card>
      <div className="flex justify-between items-baseline mb-3">
        <h3 className="text-[0.95rem] font-semibold m-0">By source</h3>
      </div>
      {entries.length === 0 ? (
        <p className="muted text-sm m-0">No source data yet. Run the backfill to populate.</p>
      ) : (
        <div className="grid gap-2 text-[0.78rem]">
          {entries.map(([key, n]) => {
            const pct = total > 0 ? Math.round((n / total) * 100) : 0
            const color = SOURCE_COLOR[key] ?? 'var(--muted-foreground)'
            const label = LABEL[key] ?? key
            return (
              <Link
                key={key}
                to={enrichmentFilterHref('autoSource', key)}
                className="flex items-center gap-[0.625rem] no-underline hover:opacity-80"
                aria-label={`View ${label} transactions`}
              >
                <span className="enrichSourceBar__label w-[3.5rem] text-right text-[var(--muted-foreground)]">{label}</span>
                <div className="flex-1 bg-[var(--muted)] h-[14px] rounded-[3px] overflow-hidden">
                  <div
                    className="h-full rounded-[3px]"
                    style={{ width: `${pct}%`, background: color }}
                  />
                </div>
                <span className="w-[6rem] text-[var(--foreground)] tabular-nums">{n.toLocaleString()} · {pct}%</span>
              </Link>
            )
          })}
        </div>
      )}
    </Card>
  )
}
