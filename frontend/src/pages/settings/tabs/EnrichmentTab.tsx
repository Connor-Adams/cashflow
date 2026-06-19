import { useCallback, useEffect, useState } from 'react'
import { Button } from '@cashflow/ui'
import { getJson } from '../../../lib/api'
import type { EnrichmentStats } from '../../../types/api'
import { EnrichmentStatRow } from './enrichment/EnrichmentStatRow'
import { EnrichmentNeedsAttention } from './enrichment/EnrichmentNeedsAttention'
import { EnrichmentCoverageChart } from './enrichment/EnrichmentCoverageChart'
import { EnrichmentConfidenceChart } from './enrichment/EnrichmentConfidenceChart'
import { EnrichmentSourceChart } from './enrichment/EnrichmentSourceChart'
import { EnrichmentTxnTypeChart } from './enrichment/EnrichmentTxnTypeChart'
import { EnrichmentTopLists } from './enrichment/EnrichmentTopLists'
import { EnrichmentBackfillCard } from './enrichment/EnrichmentBackfillCard'

export function EnrichmentTab() {
  const [stats, setStats] = useState<EnrichmentStats | null>(null)
  const [statsError, setStatsError] = useState<string | null>(null)
  const [statsLoading, setStatsLoading] = useState(false)

  const loadStats = useCallback(async () => {
    setStatsLoading(true)
    setStatsError(null)
    try {
      setStats(await getJson<EnrichmentStats>('/api/transactions/enrichment/stats'))
    } catch (e) {
      setStatsError(e instanceof Error ? e.message : 'Could not load stats')
    } finally {
      setStatsLoading(false)
    }
  }, [])

  useEffect(() => { void loadStats() }, [loadStats])

  return (
    <div className="flex flex-col gap-[0.875rem]">
      <div className="flex justify-between items-center">
        <h2 className="text-[1.05rem] font-semibold m-0">Enrichment</h2>
        <Button type="button" variant="outline" size="sm" disabled={statsLoading} onClick={() => void loadStats()}>
          Refresh stats
        </Button>
      </div>

      {statsError && <p className="error" role="alert">{statsError}</p>}

      {stats ? (
        <>
          <EnrichmentNeedsAttention stats={stats} />
          <EnrichmentStatRow stats={stats} />
          <EnrichmentCoverageChart />
          <div className="grid grid-cols-3 gap-[0.625rem] max-[900px]:grid-cols-1">
            <EnrichmentConfidenceChart byConfidence={stats.byConfidence} />
            <EnrichmentSourceChart bySource={stats.bySource} />
            <EnrichmentTxnTypeChart byTxnType={stats.byTxnType} />
          </div>
          <EnrichmentTopLists topRules={stats.topRules} topMerchants={stats.topCanonicalMerchants} deadRules={stats.deadRules} />
        </>
      ) : statsLoading ? (
        <p className="muted">Loading enrichment stats…</p>
      ) : null}

      <EnrichmentBackfillCard onComplete={() => void loadStats()} />
    </div>
  )
}
