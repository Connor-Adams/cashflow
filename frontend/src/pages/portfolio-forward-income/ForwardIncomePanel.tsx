import { useCallback, useEffect, useState } from 'react'
import { Card } from '@cashflow/ui'
import { getJson } from '../../lib/api'
import type { PortfolioForwardIncome } from '../../types/api'
import { ForwardIncomeStatsRow } from './ForwardIncomeStatsRow'
import { ForwardIncomeTable } from './ForwardIncomeTable'
import { UpcomingCalendarStrip } from './UpcomingCalendarStrip'
import { ByTaxStatusBreakdown } from './ByTaxStatusBreakdown'
import { ByAssetTypeBreakdown } from './ByAssetTypeBreakdown'
import { CaveatsBanner } from './CaveatsBanner'

export function ForwardIncomePanel() {
  const [data, setData] = useState<PortfolioForwardIncome | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    setErr(null)
    try {
      const res = await getJson<PortfolioForwardIncome>('/api/portfolio/forward-income')
      setData(res)
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not load forward income')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  if (loading) return <Card><p className="text-sm text-muted-foreground">Loading…</p></Card>
  if (err) return <p className="text-sm text-destructive">{err}</p>
  if (!data) return null

  if (data.rows.length === 0) {
    return (
      <Card>
        <p className="text-sm text-muted-foreground">
          No income-generating holdings yet — projections appear after the first paid event.
        </p>
      </Card>
    )
  }

  const unreliableSet = new Set(data.caveats.unreliableSecurityIds)
  const unreliableSymbols = data.rows
    .filter((r) => unreliableSet.has(r.securityId))
    .map((r) => r.symbol)

  return (
    <div className="flex flex-col gap-3">
      <ForwardIncomeStatsRow
        projectedAnnualIncomeCad={data.totals.projectedAnnualIncomeCad}
        forwardYieldPct={data.totals.forwardYieldPct}
        forwardYieldOnCostPct={data.totals.forwardYieldOnCostPct}
        computedAt={data.totals.computedAt}
      />
      <CaveatsBanner
        unreliableSymbols={unreliableSymbols}
        holdingsWithoutHistory={data.caveats.holdingsWithoutHistory.map((h) => ({ symbol: h.symbol, reason: h.reason }))}
      />
      <UpcomingCalendarStrip entries={data.upcoming90d} />
      <div className="grid gap-3 lg:grid-cols-2">
        <ByTaxStatusBreakdown buckets={data.byTaxStatus} />
        <ByAssetTypeBreakdown buckets={data.byAssetType} />
      </div>
      <ForwardIncomeTable rows={data.rows} />
    </div>
  )
}
