import { useEffect, useState } from 'react'
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card'
import { getJson } from '@/lib/api'
import { SanitizedHtml } from '@/components/SanitizedHtml'
import type { ChangelogListDto, ChangelogOverviewDto } from '@/lib/changelog'

export function WhatsNewTab() {
  const [overview, setOverview] = useState<ChangelogOverviewDto | null>(null)
  const [entries, setEntries] = useState<ChangelogListDto['entries']>([])
  const [error, setError] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    let active = true
    Promise.all([
      getJson<ChangelogOverviewDto>('/api/changelog/overview'),
      getJson<ChangelogListDto>('/api/changelog'),
    ])
      .then(([o, l]) => {
        if (!active) return
        setOverview(o)
        setEntries(l.entries)
      })
      .catch((e) => { if (active) setError(e instanceof Error ? e.message : 'Failed to load') })
      .finally(() => { if (active) setLoaded(true) })
    return () => { active = false }
  }, [])

  const hasOverview = !!overview && !overview.empty && !!overview.html

  if (error) return <p className="error" role="alert">{error}</p>
  if (loaded && !hasOverview && entries.length === 0) {
    return <p className="muted">No release notes yet.</p>
  }

  return (
    <div className="flex flex-col gap-4">
      {hasOverview && (
        <Card>
          <CardHeader>
            <CardTitle>What Cashflow does now</CardTitle>
          </CardHeader>
          <CardContent>
            <SanitizedHtml html={overview!.html!} />
          </CardContent>
        </Card>
      )}
      {entries.map((e) => (
        <Card key={e.version}>
          <CardHeader>
            <CardTitle>{e.title}</CardTitle>
            <CardDescription>
              {e.version} · {new Date(e.publishedAt).toLocaleDateString()}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <SanitizedHtml html={e.html} />
          </CardContent>
        </Card>
      ))}
    </div>
  )
}
