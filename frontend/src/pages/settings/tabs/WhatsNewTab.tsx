/**
 * WhatsNewTab — Settings → "What's new" tab.
 * Fetches GET /api/changelog and renders all user-audience entries.
 *
 * Issue #294 — in-app What's New changelog surface.
 */
import { useEffect, useState } from 'react'
import { Card } from '@/components/ui/card'
import { getJson } from '../../../lib/api'

interface ChangelogEntry {
  version: string
  title: string
  audience: 'user' | 'operator'
  publishedAt: string
  html: string
}

export function WhatsNewTab() {
  const [entries, setEntries] = useState<ChangelogEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(false)
    getJson<ChangelogEntry[]>('/api/changelog')
      .then((data) => {
        if (!cancelled) setEntries(data)
      })
      .catch(() => {
        if (!cancelled) setError(true)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <>
      <Card className="accountsFormCard">
        <div className="accountsCardHeader">
          <div>
            <h2>What's new</h2>
            <p className="muted">Release notes and recent improvements to Cashflow.</p>
          </div>
        </div>
      </Card>

      {loading ? (
        <p className="muted">Loading...</p>
      ) : error ? (
        <p className="muted" role="alert">
          Couldn't load changelog.
        </p>
      ) : entries.length === 0 ? (
        <p className="muted">No release notes yet.</p>
      ) : (
        <div className="flex flex-col gap-4">
          {entries.map((entry) => (
            <Card key={entry.version} className="flex flex-col gap-2">
              <div className="flex items-baseline justify-between gap-2">
                <h3 className="font-semibold">{entry.title}</h3>
                <span
                  className="shrink-0 text-xs"
                  style={{ color: 'var(--muted-foreground)' }}
                >
                  {entry.publishedAt}
                </span>
              </div>
              {/* html is sanitized server-side by changelogService */}
              <div
                className="prose prose-sm"
                // eslint-disable-next-line react/no-danger
                dangerouslySetInnerHTML={{ __html: entry.html }}
              />
            </Card>
          ))}
        </div>
      )}
    </>
  )
}
