import {
  Cell,
  Legend,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
} from 'recharts'
import { Card } from './card'
import { formatMoney } from '../../lib/formatMoney'

export type DonutSlice = {
  key: string
  name: string
  value: number
  currency: string
  percentage: number
}

const CHART_COLORS = [
  'var(--chart-line-1)',
  'var(--chart-line-2)',
  'var(--chart-line-3)',
  'var(--chart-line-4)',
  'var(--chart-line-5)',
  'var(--chart-line-6)',
]

function colorFor(index: number): string {
  return CHART_COLORS[index % CHART_COLORS.length]
}

export function AllocationDonut({
  title,
  slices,
}: {
  title: string
  slices: DonutSlice[]
}) {
  if (slices.length === 0) {
    return (
      <Card>
        <div className="transactionsPanelHeader">
          <h2>{title}</h2>
        </div>
        <p className="muted">No data.</p>
      </Card>
    )
  }
  return (
    <Card>
      <div className="transactionsPanelHeader">
        <h2 className="text-base">{title}</h2>
      </div>
      <div style={{ width: '100%', height: 240 }}>
        <ResponsiveContainer>
          <PieChart>
            <Pie
              data={slices}
              dataKey="value"
              nameKey="name"
              innerRadius={48}
              outerRadius={84}
              paddingAngle={2}
            >
              {slices.map((s, i) => (
                <Cell key={s.key} fill={colorFor(i)} />
              ))}
            </Pie>
            <Tooltip
              formatter={(value, _name, ctx) => {
                const v = typeof value === 'number' ? value : Number(value)
                if (!Number.isFinite(v)) return ''
                const slice = (ctx?.payload ?? {}) as DonutSlice
                return [
                  `${formatMoney(v, slice.currency || 'CAD')} (${slice.percentage?.toFixed(1) ?? '0.0'}%)`,
                  slice.name ?? '',
                ]
              }}
            />
            <Legend verticalAlign="bottom" height={36} />
          </PieChart>
        </ResponsiveContainer>
      </div>
    </Card>
  )
}
