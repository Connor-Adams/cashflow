import * as React from 'react'
import {
  DELTA_SIGN_STYLE,
  parseDeltaSign,
  resolveDeltaTone,
  type MetricKind,
} from '@/components/ui/delta-tone'

type SubMetric = {
  label: string
  value: string
  delta?: string
  metricKind: MetricKind
}

type SparklinePoint = {
  /** Month label, e.g. "2026-04". Used only for accessible labelling. */
  month: string
  /** Numeric value (net spend, signed). */
  value: number
}

type HeroTileProps = {
  /** Big number — the period's net spend, already formatted with currency. */
  netSpendLabel: string
  /** Optional delta string, parsed for sign coloring. Pass undefined when
   *  there's no comparison period available. */
  netSpendDelta?: string
  /** Sub-metrics rendered as text rows below the hero number (spend, refunds,
   *  income, payments). Rendered in order; the layout flows to any count. */
  subMetrics: SubMetric[]
  /** Period comparison hint (e.g. "vs previous period: 2026-04-22 to 2026-05-22"). */
  comparisonHint: string
  /** Currency context line (e.g. "In CAD"). */
  moneyHint: string
  /** Series for the inline sparkline. Empty array hides the sparkline. */
  sparklineData: SparklinePoint[]
}

const SPARKLINE_WIDTH = 320
const SPARKLINE_HEIGHT = 56

/**
 * Big-number tile for the bento dashboard. Promotes net spend; renders spend,
 * refunds/credits, income, payments as sub-rows; shows a small SVG sparkline derived from the
 * monthly breakdown so the headline number has trend context without pulling
 * in Recharts for what is essentially decoration.
 */
export function HeroTile({
  netSpendLabel,
  netSpendDelta,
  subMetrics,
  comparisonHint,
  moneyHint,
  sparklineData,
}: HeroTileProps) {
  const netSign = parseDeltaSign(netSpendDelta)
  // Net spend is a 'spend' metric — up is bad.
  const netTone = resolveDeltaTone(netSign, 'spend')

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
      {netSpendDelta && (
        <p className="heroTile__delta">
          <span
            data-slot="hero-tile-delta"
            data-sign={netSign}
            data-tone={netTone}
            className="inline-flex items-center rounded-md border px-1.5 py-0.5 text-xs font-semibold"
            style={DELTA_SIGN_STYLE[netTone]}
          >
            {netSpendDelta}
          </span>
        </p>
      )}

      {sparkPath && (
        // TODO: hover affordance (cursor + per-month tooltip) skipped — this
        // sparkline is a decorative inline SVG (no per-point markers, no event
        // surface). Adding interactivity means a mouse-to-bucket mapping +
        // crosshair overlay; better handled by promoting to a Recharts
        // LineChart in a follow-up than bolting onto raw paths here.
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
        {subMetrics.map((m) => {
          const sign = parseDeltaSign(m.delta)
          const tone = resolveDeltaTone(sign, m.metricKind)
          return (
            <div key={m.label} className="heroTile__subMetric">
              <dt>{m.label}</dt>
              <dd>
                <span className="heroTile__subMetricValue">{m.value}</span>
                {m.delta && (
                  <span
                    data-sign={sign}
                    data-tone={tone}
                    className="inline-flex items-center rounded-md border px-1.5 py-0.5 text-xs font-semibold ml-2"
                    style={DELTA_SIGN_STYLE[tone]}
                  >
                    {m.delta}
                  </span>
                )}
              </dd>
            </div>
          )
        })}
      </dl>

      <p className="heroTile__hint">{comparisonHint}</p>
    </div>
  )
}

/**
 * Build SVG path strings for the sparkline. Returns null when there's
 * insufficient data to draw a meaningful line (fewer than 2 points).
 *
 * - `line`: stroke path along the data points
 * - `area`: closed polygon filling under the line, for the soft fill below
 *
 * Values are scaled so the minimum sits at the bottom of the viewport and
 * the maximum at the top, with 4px vertical padding so the stroke doesn't
 * clip at the edges.
 */
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
