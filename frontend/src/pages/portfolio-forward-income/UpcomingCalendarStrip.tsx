import { Link } from 'react-router-dom'
import type { PortfolioForwardIncomeUpcomingEntry } from '../../types/api'
import { formatMoney } from '../../lib/formatMoney'

export type UpcomingCalendarStripProps = {
  entries: PortfolioForwardIncomeUpcomingEntry[]
}

function fmtDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d))
  return dt.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

export function UpcomingCalendarStrip({ entries }: UpcomingCalendarStripProps) {
  if (entries.length === 0) {
    return <p className="text-sm text-muted-foreground mt-3">No payments expected in next 90 days.</p>
  }
  return (
    <div className="mt-3 flex gap-2 overflow-x-auto pb-2">
      {entries.map((e, i) => (
        <Link
          key={`${e.securityId}-${e.date}-${i}`}
          to={`/portfolio/security/${e.securityId}`}
          className="flex-shrink-0 rounded border p-2 hover:bg-muted"
        >
          <p className="text-xs text-muted-foreground">{fmtDate(e.date)}</p>
          <p className="font-medium" data-testid="fi-cal-symbol">{e.symbol}</p>
          <p className="text-xs">{formatMoney(e.estimatedTotalCad, 'CAD')}</p>
        </Link>
      ))}
    </div>
  )
}
