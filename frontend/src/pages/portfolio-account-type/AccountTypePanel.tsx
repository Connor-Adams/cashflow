import { useCallback, useEffect, useState } from 'react'
import { Card } from '@/components/ui/card'
import { getJson } from '../../lib/api'
import type { PortfolioByAccountType } from '../../types/api'
import { BucketBreakdownTable } from './BucketBreakdownTable'
import { BucketCard } from './BucketCard'
import { HarvestCandidatesStrip } from './HarvestCandidatesStrip'
import { TaxWarningsStrip } from './TaxWarningsStrip'

export function AccountTypePanel() {
  const [data, setData] = useState<PortfolioByAccountType | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    setErr(null)
    try {
      const res = await getJson<PortfolioByAccountType>('/api/portfolio/by-account-type')
      setData(res)
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not load by-account-type view')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  if (loading) return <Card><p className="muted">Loading…</p></Card>
  if (err) return <p className="error">{err}</p>
  if (!data) return null

  if (data.buckets.length === 0) {
    return (
      <Card>
        <p className="muted">
          No investment accounts. Add one via the Accounts page and import a statement to see this view.
        </p>
      </Card>
    )
  }

  return (
    <>
      <TaxWarningsStrip warnings={data.warnings} />
      <HarvestCandidatesStrip candidates={data.harvestCandidates} />
      <div className="grid gap-4 lg:grid-cols-2 mt-3">
        {data.buckets.map((b) => (
          <BucketCard key={b.taxStatus} bucket={b} />
        ))}
      </div>
      <BucketBreakdownTable buckets={data.buckets} />
    </>
  )
}
