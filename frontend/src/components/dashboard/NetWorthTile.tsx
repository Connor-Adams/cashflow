import { Link } from 'react-router-dom'
import { Area, AreaChart, ResponsiveContainer } from 'recharts'
import { BentoTile } from './BentoTile'
import { useNetWorthCurrent, useNetWorthSeries } from '@/hooks/useNetWorth'
import { formatMoney } from '@/lib/formatMoney'

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
    <BentoTile span={4} rows={1} label="Net worth" aria-busy={current.loading}>
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
              <div className="text-2xl font-semibold">
                {formatMoney(current.data.total, 'CAD')}
              </div>
              <div className="text-xs text-muted-foreground">
                Assets {formatMoney(current.data.assetsTotal, 'CAD')} · Liabilities{' '}
                {formatMoney(current.data.liabilitiesTotal, 'CAD')}
              </div>
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
