import { useMemo } from 'react'
import { Rectangle, ResponsiveContainer, Sankey, Tooltip } from 'recharts'
import { formatMoney } from '../lib/formatMoney'
import { SANKEY_LABEL_FONT_SIZE, sankeyNodePadding } from '../lib/sankeyLayout'
import type { SankeyNode as SankeyNodeType, SankeyResponse } from '../types/api'

/**
 * Node fill per backend `kind`. Tailwind v4 JIT requires literal class names
 * (lookup tables, not concatenation), so we map to CSS vars directly.
 *
 * Every entry must name a token `@connor-adams/tokens` actually defines —
 * these are the same swatches the dashboard's other recharts components use,
 * and they carry their own light/dark values, so the chart follows the theme
 * for free. An invented token paints SVG-default black (and an invented
 * *stroke* paints nothing at all), which is how this chart previously shipped
 * as black bars with no visible ribbons. `SankeyChart.test.tsx` guards it.
 */
const NODE_COLORS: Record<SankeyNodeType['kind'], string> = {
  // Money in, and the slice of it that survived: the two green ends of the
  // chain. They never sit adjacent, so sharing a hue reads as a rhyme.
  income: 'var(--chart-credit)',
  surplus: 'var(--chart-personal)',
  // The corporate side-branch, kept visually apart from personal spend.
  business: 'var(--chart-business)',
  // The waypoint between corporate revenue and personal spend.
  draws: 'var(--chart-4)',
  // Money out.
  category: 'var(--chart-spend)',
  savings: 'var(--chart-line-5)',
  uncategorized: 'var(--chart-5)',
}

/** Ribbon colour. Neutral so the node fills carry the meaning. */
const LINK_STROKE = 'var(--chart-payment)'

const DEFAULT_HEIGHT = 520

/**
 * Narrowest the chart may be drawn. A Sankey is wide-format content: the node
 * labels sit in the gaps between columns, so squeezing four columns into a
 * phone viewport overprints "Income" on "Owner draws". Below this width the
 * chart scrolls sideways inside its own container rather than compressing —
 * the page body still never scrolls horizontally.
 */
const MIN_CHART_WIDTH = 720

export type SankeyChartProps = {
  /** Aggregator payload. Renders nothing when `nodes` is empty. */
  data: SankeyResponse
  /** Currency for tooltip money formatting. */
  currency: string
  /** Chart height in px. Default 520 (the full page); the dashboard embed
   *  passes a shorter value. */
  height?: number
  /**
   * When provided, link paths become clickable and report the clicked edge
   * by node index. Omit it for a read-only embed — links then render inert
   * with no pointer affordance.
   */
  onLinkClick?: (source: number, target: number) => void
}

/**
 * The Cashflow Sankey chart, with no controls of its own.
 *
 * Extracted out of `SankeyPage` (2026-09-27 full-chain spec) so the Dashboard
 * can render the same picture scoped to the range it already holds. The page
 * keeps the filters, stat cards and drill-down; everything the *chart* needs
 * arrives as props.
 */
export function SankeyChart({
  data,
  currency,
  height = DEFAULT_HEIGHT,
  onLinkClick,
}: SankeyChartProps) {
  // Recharts mutates its `data` prop during layout; pass a deep clone so
  // React's reconciliation doesn't observe in-place mutations as upstream
  // state churn.
  const sankeyData = useMemo(() => {
    if (data.nodes.length === 0) return null
    return {
      nodes: data.nodes.map((n) => ({ ...n })),
      links: data.links.map((l) => ({ ...l })),
    }
  }, [data])

  const kinds = useMemo(() => data.nodes.map((n) => n.kind), [data.nodes])

  // Gaps have to fit the busiest column, not a guess — see sankeyLayout.ts.
  const nodePadding = useMemo(
    () => sankeyNodePadding(height, data.nodes.length, data.links),
    [data.nodes.length, data.links, height],
  )

  if (sankeyData === null) return null

  return (
    <div className="w-full overflow-x-auto">
      <div
        data-slot="sankey-chart"
        style={{ height, minWidth: MIN_CHART_WIDTH }}
      >
        <ResponsiveContainer width="100%" height="100%">
          <Sankey
            data={sankeyData}
            nodePadding={nodePadding}
            nodeWidth={14}
            iterations={64}
            node={(props) => <SankeyNode {...props} kinds={kinds} />}
            link={(props) => (
              <SankeyLinkPath {...props} onLinkClick={onLinkClick} />
            )}
          >
            <Tooltip
              formatter={(value) => {
                const n = typeof value === 'number' ? value : Number(value)
                return Number.isFinite(n)
                  ? formatMoney(n, currency)
                  : String(value)
              }}
            />
          </Sankey>
        </ResponsiveContainer>
      </div>
    </div>
  )
}

// ---- Custom node renderer ---------------------------------------------

type NodeRendererProps = {
  x: number
  y: number
  width: number
  height: number
  index: number
  payload: { name?: string; value?: number }
  kinds: SankeyNodeType['kind'][]
}

function SankeyNode({
  x,
  y,
  width,
  height,
  index,
  payload,
  kinds,
}: NodeRendererProps) {
  const kind = kinds[index] ?? 'category'
  const fill = NODE_COLORS[kind] ?? NODE_COLORS.category
  const labelOnRight = index === 0
  const labelX = labelOnRight ? x + width + 8 : x - 8
  const textAnchor = labelOnRight ? 'start' : 'end'
  const labelY = y + height / 2
  return (
    <g>
      <Rectangle
        x={x}
        y={y}
        width={width}
        height={height}
        fill={fill}
        fillOpacity={0.95}
        stroke="var(--border)"
        strokeOpacity={0.6}
      />
      <text
        textAnchor={textAnchor}
        x={labelX}
        y={labelY}
        dy="0.35em"
        fontSize={SANKEY_LABEL_FONT_SIZE}
        className="fill-foreground"
      >
        {payload.name}
      </text>
    </g>
  )
}

// ---- Custom link renderer ---------------------------------------------

type LinkRendererProps = {
  sourceX: number
  targetX: number
  sourceY: number
  targetY: number
  sourceControlX: number
  targetControlX: number
  linkWidth: number
  index: number
  payload: {
    source: number | { name?: string; sourceLinks?: unknown[]; targetLinks?: unknown[] }
    target: number | { name?: string; sourceLinks?: unknown[]; targetLinks?: unknown[] }
    value: number
  }
  onLinkClick?: (source: number, target: number) => void
}

/**
 * Custom link renderer that draws the recharts-default bezier path and, when
 * the consumer supplied `onLinkClick`, routes clicks to it.
 *
 * Recharts mutates link.source/target into node objects after layout, so the
 * indices are recovered from the payload rather than assumed.
 */
function SankeyLinkPath({
  sourceX,
  targetX,
  sourceY,
  targetY,
  sourceControlX,
  targetControlX,
  linkWidth,
  payload,
  onLinkClick,
}: LinkRendererProps) {
  const d = `M${sourceX},${sourceY}C${sourceControlX},${sourceY} ${targetControlX},${targetY} ${targetX},${targetY}`
  const clickable = onLinkClick != null
  const handleClick = () => {
    if (!onLinkClick) return
    const source = resolveLinkEnd(payload.source)
    const target = resolveLinkEnd(payload.target)
    if (source == null || target == null) return
    onLinkClick(source, target)
  }
  return (
    <path
      d={d}
      fill="none"
      stroke={LINK_STROKE}
      strokeOpacity={0.3}
      strokeWidth={linkWidth}
      onClick={clickable ? handleClick : undefined}
      style={clickable ? { cursor: 'pointer' } : undefined}
      data-testid="sankey-link"
    />
  )
}

function resolveLinkEnd(
  end: number | { index?: number; name?: string },
): number | null {
  if (typeof end === 'number') return end
  if (end && typeof end.index === 'number') return end.index
  return null
}
