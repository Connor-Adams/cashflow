import { useEffect, useState } from 'react'
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { Card } from '@connor-adams/designsystem'
import { getJson } from '../../../../lib/api'
import type { EnrichmentCoverage } from '../../../../types/api'

type Bucket = 'month' | 'week'

export function EnrichmentCoverageChart() {
  const [bucket, setBucket] = useState<Bucket>('month')
  const [data, setData] = useState<EnrichmentCoverage | null>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    setErr(null)
    getJson<EnrichmentCoverage>(`/api/transactions/enrichment/coverage?bucket=${bucket}`)
      .then((d) => { if (live) setData(d) })
      .catch((e) => { if (live) setErr(e instanceof Error ? e.message : 'Could not load coverage') })
    return () => { live = false }
  }, [bucket])

  const rows = (data?.series ?? []).map((p) => ({
    period: p.period,
    clearedPct: p.total > 0 ? Math.round((p.cleared / p.total) * 100) : 0,
    canonicalPct: p.total > 0 ? Math.round((p.withCanonical / p.total) * 100) : 0,
  }))

  return (
    <Card>
      <div className="flex justify-between items-baseline mb-3">
        <h3 className="text-[0.95rem] font-semibold m-0">Coverage over time</h3>
        <div className="flex gap-1 text-[0.72rem]">
          {(['month', 'week'] as Bucket[]).map((b) => (
            <button
              key={b}
              type="button"
              onClick={() => setBucket(b)}
              className={`px-2 py-0.5 rounded-full border ${b === bucket ? 'bg-[var(--primary)] text-[var(--primary-foreground)]' : 'text-[var(--muted-foreground)]'}`}
            >
              {b}
            </button>
          ))}
        </div>
      </div>
      {err ? (
        <p className="error m-0" role="alert">{err}</p>
      ) : rows.length === 0 ? (
        <p className="muted text-sm m-0">No coverage data yet.</p>
      ) : (
        <ResponsiveContainer width="100%" height={180}>
          <AreaChart data={rows} margin={{ top: 4, right: 8, bottom: 0, left: -16 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
            <XAxis dataKey="period" tick={{ fontSize: 11 }} stroke="var(--muted-foreground)" />
            <YAxis domain={[0, 100]} tick={{ fontSize: 11 }} stroke="var(--muted-foreground)" />
            <Tooltip />
            <Area type="monotone" dataKey="clearedPct" name="% cleared" stroke="var(--success)" fill="var(--success)" fillOpacity={0.2} />
            <Area type="monotone" dataKey="canonicalPct" name="% canonical" stroke="var(--primary)" fill="var(--primary)" fillOpacity={0.15} />
          </AreaChart>
        </ResponsiveContainer>
      )}
      <p className="muted text-[0.7rem] mt-2 mb-0">Bucketed by spend date.</p>
    </Card>
  )
}
