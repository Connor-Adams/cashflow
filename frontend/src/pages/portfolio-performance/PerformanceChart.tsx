import { Card } from '@/components/ui/card'
import { LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid } from 'recharts'
import type { PortfolioPerformancePoint } from '../../types/api'

export type PerformanceChartProps = {
  points: PortfolioPerformancePoint[]
}

function fmtY(v: number): string {
  if (Math.abs(v) >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`
  if (Math.abs(v) >= 1_000) return `$${(v / 1_000).toFixed(0)}K`
  return `$${v.toFixed(0)}`
}

export function PerformanceChart({ points }: PerformanceChartProps) {
  if (points.length === 0) {
    return (
      <Card>
        <p className="text-sm text-muted-foreground">
          No data yet — first snapshot lands tomorrow morning. Historical prices backfilling in background.
        </p>
      </Card>
    )
  }
  return (
    <Card className="p-3 overflow-x-auto">
      <LineChart width={800} height={320} data={points}>
        <CartesianGrid strokeDasharray="3 3" />
        <XAxis dataKey="date" />
        <YAxis tickFormatter={fmtY} />
        <Tooltip />
        <Line
          type="monotone"
          dataKey="portfolioValueCad"
          name="Portfolio"
          stroke="#2563eb"
          dot={false}
          isAnimationActive={false}
        />
        <Line
          type="monotone"
          dataKey="benchmarkValueCad"
          name="Benchmark"
          stroke="#94a3b8"
          strokeDasharray="5 5"
          dot={false}
          isAnimationActive={false}
        />
      </LineChart>
    </Card>
  )
}
