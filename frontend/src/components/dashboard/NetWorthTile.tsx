import { Link } from 'react-router-dom'
import { Area, AreaChart, ResponsiveContainer } from 'recharts'
import { BentoTile } from './BentoTile'
import {
  useCreditUtilization,
  useNetWorthCurrent,
  useNetWorthSeries,
} from '@/hooks/useNetWorth'
import { formatMoney } from '@/lib/formatMoney'

/**
 * Per-currency credit-utilization summary line (#437). Renders one line per
 * currency that has at least one active credit card with a limit set:
 *   "Credit utilization: 28% across 3 cards (CAD)"
 * Colour-coded subtly: amber > 30%, red > 70%. Hidden entirely if no
 * eligible cards exist.
 */
function CreditUtilizationLine() {
  const { data } = useCreditUtilization()
  if (!data || data.length === 0) return null
  return (
    <>
      {data.map((bucket) => {
        const tone =
          bucket.utilizationPct > 70
            ? 'text-red-700'
            : bucket.utilizationPct > 30
              ? 'text-amber-700'
              : 'text-muted-foreground'
        const cardLabel = bucket.cardCount === 1 ? 'card' : 'cards'
        return (
          <div key={bucket.currency} className={`text-xs ${tone}`}>
            Credit utilization: {Math.round(bucket.utilizationPct)}% across{' '}
            {bucket.cardCount} {cardLabel} ({bucket.currency})
          </div>
        )
      })}
    </>
  )
}

function oneYearAgo(): { from: string; to: string } {
  const today = new Date()
  const from = new Date(today)
  from.setUTCFullYear(from.getUTCFullYear() - 1)
  return {
    from: from.toISOString().slice(0, 10),
    to: today.toISOString().slice(0, 10),
  }
}

export function NetWorthTile() {
  const current = useNetWorthCurrent()
  const series = useNetWorthSeries({ ...oneYearAgo(), granularity: 'monthly' })

  return (
    <BentoTile span={4} rows={2} label="Net worth" aria-busy={current.loading}>
      <Link to="/net-worth" className="block">
        {current.loading && !current.data ? (
          <div className="text-sm text-muted-foreground">Loading…</div>
        ) : !current.data ? (
          <div className="text-sm text-muted-foreground">
            {current.error?.message ?? 'Unavailable'}
          </div>
        ) : (
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-4xl font-semibold tabular-nums">
                {formatMoney(current.data.total, 'CAD')}
              </div>
              <div className="text-xs text-muted-foreground">
                Assets {formatMoney(current.data.assetsTotal, 'CAD')} · Liabilities{' '}
                {formatMoney(current.data.liabilitiesTotal, 'CAD')}
              </div>
              <CreditUtilizationLine />
            </div>
            <div className="w-28 h-12">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={series.data?.points ?? []}>
                  <Area type="monotone" dataKey="total" />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </div>
        )}
      </Link>
    </BentoTile>
  )
}
