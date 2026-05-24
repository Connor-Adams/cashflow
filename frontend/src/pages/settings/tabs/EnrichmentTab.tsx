import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { getJson } from '../../../lib/api'
import type { EnrichmentStats } from '../../../types/api'
import { EnrichmentStatRow } from './enrichment/EnrichmentStatRow'
import { EnrichmentConfidenceChart } from './enrichment/EnrichmentConfidenceChart'
import { EnrichmentSourceChart } from './enrichment/EnrichmentSourceChart'
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

  useEffect(() => {
    void loadStats()
  }, [loadStats])

  return (
    <div className="enrichTabRoot">
      {statsError && (
        <p className="error" role="alert">{statsError}</p>
      )}

      {stats ? (
        <>
          <EnrichmentStatRow stats={stats} />
          <div className="enrichChartsGrid">
            <EnrichmentConfidenceChart byConfidence={stats.byConfidence} />
            <EnrichmentSourceChart bySource={stats.bySource} />
          </div>
          <EnrichmentTopLists topRules={stats.topRules} topMerchants={stats.topCanonicalMerchants} />
        </>
      ) : statsLoading ? (
        <p className="muted">Loading enrichment stats…</p>
      ) : null}

      <div className="enrichRefreshRow">
        <Button type="button" variant="outline" size="sm" disabled={statsLoading} onClick={() => void loadStats()}>
          Refresh stats
        </Button>
      </div>

      <EnrichmentBackfillCard onComplete={() => void loadStats()} />
    </div>
  )
}
