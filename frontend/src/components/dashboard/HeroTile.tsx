import * as React from 'react'
import { DeltaBadge } from '@/components/ui/DeltaBadge'
import type { MetricKind } from '@/components/ui/delta-tone'

type SubMetric = {
  label: string
  value: string
  delta?: number
  metricKind: MetricKind
}

type SparklinePoint = {
  month: string
  value: number
}

type HeroTileProps = {
  netSpendLabel: string
  netSpendDelta?: number
  deltaCurrency: string
  subMetrics: SubMetric[]
  comparisonHint: string
  moneyHint: string
  sparklineData: SparklinePoint[]
}

const SPARKLINE_WIDTH = 320
const SPARKLINE_HEIGHT = 56

export function HeroTile({
  netSpendLabel,
  netSpendDelta,
  deltaCurrency,
  subMetrics,
  comparisonHint,
  moneyHint,
  sparklineData,
}: HeroTileProps) {
  const sparkPath = React.useMemo(
    () => buildSparkPath(sparklineData),
    [sparklineData]
  )

  return (
    <div className="heroTile">
      <p className="heroTile__label">Net spend · {moneyHint}</p>
      <p className="heroTile__value" title={netSpendLabel}>
        {netSpendLabel}
      </p>
      {netSpendDelta != null && (
        <p className="heroTile__delta">
          <DeltaBadge
            delta={netSpendDelta}
            metricKind="spend"
            currency={deltaCurrency}
          />
        </p>
      )}

      {sparkPath && (
        <svg
          className="heroTile__sparkline"
          viewBox={`0 0 ${SPARKLINE_WIDTH} ${SPARKLINE_HEIGHT}`}
          preserveAspectRatio="none"
          aria-label={`Monthly net spend trend across ${sparklineData.length} months`}
          role="img"
        >
          <path
            d={sparkPath.area}
            fill="color-mix(in oklch, var(--primary) 18%, transparent)"
            stroke="none"
          />
          <path
            d={sparkPath.line}
            fill="none"
            stroke="var(--primary)"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      )}

      <dl className="heroTile__subMetrics">
        {subMetrics.map((m) => (
          <div key={m.label} className="heroTile__subMetric">
            <dt>{m.label}</dt>
            <dd>
              <span className="heroTile__subMetricValue">{m.value}</span>
              {m.delta != null && (
                <DeltaBadge
                  delta={m.delta}
                  metricKind={m.metricKind}
                  currency={deltaCurrency}
                  className="ml-2"
                />
              )}
            </dd>
          </div>
        ))}
      </dl>

      <p className="heroTile__hint">{comparisonHint}</p>
    </div>
  )
}

function buildSparkPath(data: SparklinePoint[]): { line: string; area: string } | null {
  if (data.length < 2) return null
  const values = data.map((d) => d.value)
  const min = Math.min(...values)
  const max = Math.max(...values)
  const range = max - min || 1
  const padY = 4
  const innerH = SPARKLINE_HEIGHT - padY * 2
  const stepX = SPARKLINE_WIDTH / (data.length - 1)

  const points = data.map((d, i) => {
    const x = i * stepX
    const y = padY + innerH - ((d.value - min) / range) * innerH
    return [x, y] as const
  })

  const line = points
    .map(([x, y], i) => `${i === 0 ? 'M' : 'L'} ${x.toFixed(2)} ${y.toFixed(2)}`)
    .join(' ')

  const first = points[0]
  const last = points[points.length - 1]
  const area = `${line} L ${last[0].toFixed(2)} ${SPARKLINE_HEIGHT} L ${first[0].toFixed(2)} ${SPARKLINE_HEIGHT} Z`

  return { line, area }
}
