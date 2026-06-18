import { Link } from 'react-router-dom'
import { Card } from '@/components/ui/card'
import { enrichmentFilterHref } from './enrichmentFilterHref'

type Props = { byTxnType: Record<string, number> }

export function EnrichmentTxnTypeChart({ byTxnType }: Props) {
  const entries = Object.entries(byTxnType).sort((a, b) => b[1] - a[1])
  const total = entries.reduce((acc, [, n]) => acc + n, 0)
  return (
    <Card>
      <div className="flex justify-between items-baseline mb-3">
        <h3 className="text-[0.95rem] font-semibold m-0">By type</h3>
      </div>
      {entries.length === 0 ? (
        <p className="muted text-sm m-0">No transactions yet.</p>
      ) : (
        <div className="grid gap-2 text-[0.78rem]">
          {entries.map(([key, n]) => {
            const pct = total > 0 ? Math.round((n / total) * 100) : 0
            const label = key === '(none)' ? 'none' : key
            return (
              <Link
                key={key}
                to={enrichmentFilterHref('txnType', key)}
                className="flex items-center gap-[0.625rem] no-underline hover:opacity-80"
                aria-label={`View ${label} transactions`}
              >
                <span className="w-[5rem] text-right text-[var(--muted-foreground)] truncate">{label}</span>
                <div className="flex-1 bg-[var(--muted)] h-[14px] rounded-[3px] overflow-hidden">
                  <div className="h-full rounded-[3px] bg-[var(--chart-4)]" style={{ width: `${pct}%` }} />
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
