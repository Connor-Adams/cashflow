import { Card } from '@/components/ui/card'
import type { PortfolioPerformanceStats } from '../../types/api'

export type PerformanceStatsRowProps = {
  presetStats: {
    '1M': PortfolioPerformanceStats
    '3M': PortfolioPerformanceStats
    'YTD': PortfolioPerformanceStats
    '1Y': PortfolioPerformanceStats
    'All': PortfolioPerformanceStats
  }
}

function fmtPct(x: number): string {
  return `${x.toFixed(2)}%`
}

function fmtDelta(x: number): string {
  const sign = x >= 0 ? '+' : ''
  return `${sign}${x.toFixed(2)}%`
}

const KEYS: Array<keyof PerformanceStatsRowProps['presetStats']> = ['1M', '3M', 'YTD', '1Y', 'All']

export function PerformanceStatsRow({ presetStats }: PerformanceStatsRowProps) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
      {KEYS.map((k) => {
        const stat = presetStats[k]
        const positive = stat.twrPct >= 0
        return (
          <Card key={k}>
            <p className="text-sm text-muted-foreground">{k}</p>
            <p className={`text-2xl font-semibold ${positive ? 'text-positive' : 'text-negative'}`}>
              {fmtPct(stat.twrPct)}
            </p>
            <p className="text-xs text-muted-foreground mt-1">
              vs benchmark: {fmtDelta(stat.vsBenchmarkDeltaPct)}
            </p>
          </Card>
        )
      })}
    </div>
  )
}
