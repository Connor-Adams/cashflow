import { useCallback, useEffect, useState } from 'react'
import { Card } from '@connor-adams/designsystem'
import { getJson } from '../../lib/api'
import type { PortfolioPerformance, PortfolioPerformanceRange } from '../../types/api'
import { PerformanceStatsRow } from './PerformanceStatsRow'
import { PerformanceChart } from './PerformanceChart'
import { PerformanceRangeToggle } from './PerformanceRangeToggle'
import { CustomRangePicker } from './CustomRangePicker'
import { ByAccountTable } from './ByAccountTable'
import { BenchmarkPickerCard } from './BenchmarkPickerCard'
import { PerformanceCaveatsBanner } from './PerformanceCaveatsBanner'

export function PerformancePanel() {
  const [range, setRange] = useState<PortfolioPerformanceRange>('1Y')
  const [customFrom, setCustomFrom] = useState<string>('')
  const [customTo, setCustomTo] = useState<string>('')
  const [data, setData] = useState<PortfolioPerformance | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    setErr(null)
    try {
      const qs = range === 'custom'
        ? `?range=custom&from=${customFrom}&to=${customTo}`
        : `?range=${range}`
      const res = await getJson<PortfolioPerformance>(`/api/portfolio/performance${qs}`)
      setData(res)
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not load performance')
    } finally {
      setLoading(false)
    }
  }, [range, customFrom, customTo])

  useEffect(() => {
    if (range === 'custom' && (!customFrom || !customTo)) return
    void load()
  }, [load, range, customFrom, customTo])

  if (loading && !data) return <Card><p className="text-sm text-muted-foreground">Loading…</p></Card>
  if (err && !data) return <p className="text-sm text-destructive">{err}</p>
  if (!data) return null

  return (
    <div className="flex flex-col gap-3">
      <BenchmarkPickerCard currentSymbol={data.caveats.benchmarkSymbol} onChange={() => void load()} />
      <PerformanceCaveatsBanner
        partialDaysCount={data.caveats.partialDaysCount}
        missingDataReasons={data.caveats.missingDataReasons}
        benchmarkSymbol={data.caveats.benchmarkSymbol}
        benchmarkIsPartial={data.caveats.benchmarkIsPartial}
      />
      <PerformanceStatsRow presetStats={data.presetStats} />
      <PerformanceRangeToggle value={range} onChange={setRange} />
      {range === 'custom' && (
        <CustomRangePicker
          from={customFrom || data.series[0]?.date || '2026-01-01'}
          to={customTo || data.series[data.series.length - 1]?.date || '2026-05-25'}
          onApply={({ from, to }) => { setCustomFrom(from); setCustomTo(to) }}
        />
      )}
      <PerformanceChart points={data.series} />
      <ByAccountTable rows={data.byAccount} />
    </div>
  )
}
