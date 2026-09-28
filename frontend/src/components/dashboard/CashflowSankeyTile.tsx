import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Button, Icon } from '@connor-adams/designsystem'
import { BentoTile } from './BentoTile'
import { SankeyChart } from '@/components/SankeyChart'
import { getJson } from '@/lib/api'
import { formatMoney } from '@/lib/formatMoney'
import { summaryQueryString } from '@/lib/summaryQuery'
import type { SankeyResponse } from '@/types/api'

type CashflowSankeyTileProps = {
  /** The dashboard's selected currency. Inherited, never re-picked here. */
  currency: string
  /** The dashboard's date range. Inherited, never re-picked here. */
  dateFrom: string
  dateTo: string
}

/**
 * Shorter than the full page's 520px, but not by much: the full chain stacks
 * a dozen-plus terminal nodes in its last column, and anything under ~400px
 * leaves each band a hairline no matter how the padding is tuned.
 */
const TILE_CHART_HEIGHT = 420

/**
 * Homepage embed of the Cashflow Sankey (2026-09-27 full-chain spec, §4).
 *
 * It renders the same `SankeyChart` the `/reports/cashflow` page does, scoped
 * to the currency and date range the dashboard already holds — so the tile is
 * strictly period-bound like every other range-bound tile, and grows no
 * controls of its own. Drill-down and the stat cards stay on the full page,
 * which the header links through to.
 */
export function CashflowSankeyTile({
  currency,
  dateFrom,
  dateTo,
}: CashflowSankeyTileProps) {
  const [data, setData] = useState<SankeyResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setErr(null)
    const qs = summaryQueryString({ currency, dateFrom, dateTo })
    getJson<SankeyResponse>(`/api/summary/sankey${qs}`)
      .then((json) => {
        if (cancelled) return
        setData(json)
      })
      .catch(() => {
        if (cancelled) return
        setData(null)
        setErr('Cashflow chart unavailable for this period.')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [currency, dateFrom, dateTo])

  const hasFlows =
    data !== null &&
    data.nodes.length > 0 &&
    !(data.totalIncome === 0 && data.totalSpend === 0)

  return (
    <BentoTile
      span={12}
      rows={2}
      aria-busy={loading}
      icon={<Icon name="git-merge" className="size-5" />}
      label="Where the money went"
      description={
        hasFlows
          ? describeFlows(data, currency)
          : 'Income into draws, categories and surplus — for the range above.'
      }
      actions={
        <Link to="/reports/cashflow">
          <Button size="sm" variant="outline">
            Open full chart
          </Button>
        </Link>
      }
    >
      {err ? (
        <p className="m-0 text-sm text-muted-foreground">{err}</p>
      ) : loading && data === null ? (
        <p className="m-0 text-sm text-muted-foreground">Loading cashflow…</p>
      ) : hasFlows && data ? (
        <SankeyChart
          data={data}
          currency={currency || data.currency || 'CAD'}
          height={TILE_CHART_HEIGHT}
        />
      ) : (
        <p className="m-0 text-sm text-muted-foreground">
          No flows in this period. Widen the date range, or check that income
          and categories are set on these transactions.
        </p>
      )}
    </BentoTile>
  )
}

/**
 * One-line summary under the tile label. Income / spend / surplus for the
 * inherited range only — the chart's own totals, never an all-time figure.
 * An unbalanced chart says so rather than presenting the surplus as settled.
 */
function describeFlows(data: SankeyResponse, currency: string): string {
  const c = currency || data.currency || 'CAD'
  const head = `${formatMoney(data.totalIncome, c)} in · ${formatMoney(
    data.totalSpend,
    c,
  )} out · ${formatMoney(data.surplus, c)} surplus.`
  return data.balanced
    ? head
    : `${head} Spend exceeds the income we can see here, so the chart cannot close.`
}
