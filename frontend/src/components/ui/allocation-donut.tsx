import type { ReactNode } from 'react'
import {
  Cell, Legend, Pie, PieChart, ResponsiveContainer, Tooltip, } from 'recharts'
import { Card } from '@connor-adams/designsystem'
import { formatMoney } from '../../lib/formatMoney'
import { safePct } from '../../lib/num'

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

export type AllocationDonutProps = {
  title: string
  slices: DonutSlice[]
  /**
   * Wrap output in a `<Card>`. Defaults to `true` for back-compat with the
   * Allocation tab. Pass `false` when nesting inside another `<Card>` (e.g.
   * `BucketCard`) to avoid doubled borders.
   */
  wrapInCard?: boolean
}

export function AllocationDonut({
  title,
  slices,
  wrapInCard = true,
}: AllocationDonutProps) {
  const wrap = (content: ReactNode) =>
    wrapInCard ? <Card>{content}</Card> : <>{content}</>

  if (slices.length === 0) {
    return wrap(
      <>
        <div className="transactionsPanelHeader">
          <h2>{title}</h2>
        </div>
        <p className="muted">No data.</p>
      </>,
    )
  }
  return wrap(
    <>
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
                  `${formatMoney(v, slice.currency || 'CAD')} (${safePct(slice.percentage)})`,
                  slice.name ?? '',
                ]
              }}
            />
            <Legend verticalAlign="bottom" height={36} />
          </PieChart>
        </ResponsiveContainer>
      </div>
    </>,
  )
}
