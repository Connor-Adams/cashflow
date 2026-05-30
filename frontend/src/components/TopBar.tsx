/**
 * TopBar — application top bar with "What's new" changelog badge.
 *
 * On mount: fetches GET /api/changelog/latest and GET /api/preferences.
 * If the latest entry's version is newer than lastSeenChangelogVersion
 * (or lastSeenChangelogVersion is null), shows a "What's new" pill.
 * Clicking the pill opens the ChangelogModal. On dismiss, PATCHes
 * /api/preferences with the new version and hides the badge.
 *
 * Errors are handled silently so TopBar never breaks due to changelog
 * service failures.
 *
 * Issue #294 — in-app What's New changelog surface.
 */
import { useEffect, useState } from 'react'
import { Newspaper } from 'lucide-react'
import { getJson, patchJson } from '../lib/api'
import { ChangelogModal } from './changelog/ChangelogModal'

interface ChangelogEntry {
  version: string
  title: string
  html: string
  publishedAt: string
}

interface LatestResponse {
  empty?: boolean
  version?: string
  title?: string
  html?: string
  publishedAt?: string
}

interface PreferencesResponse {
  lastSeenChangelogVersion: string | null
}

export function WhatsNewBadge() {
  const [latestEntry, setLatestEntry] = useState<ChangelogEntry | null>(null)
  const [showBadge, setShowBadge] = useState(false)
  const [showModal, setShowModal] = useState(false)

  useEffect(() => {
    let cancelled = false

    async function load() {
      try {
        const [latest, prefs] = await Promise.all([
          getJson<LatestResponse>('/api/changelog/latest'),
          getJson<PreferencesResponse>('/api/preferences'),
        ])

        if (cancelled) return

        if (!latest || latest.empty || !latest.version) return

        const entry: ChangelogEntry = {
          version: latest.version,
          title: latest.title ?? latest.version,
          html: latest.html ?? '',
          publishedAt: latest.publishedAt ?? '',
        }

        setLatestEntry(entry)

        const lastSeen = prefs.lastSeenChangelogVersion ?? null
        if (!lastSeen || entry.version > lastSeen) {
          setShowBadge(true)
        }
      } catch {
        // Fail silently — TopBar must remain functional
      }
    }

    void load()

    return () => {
      cancelled = true
    }
  }, [])

  async function handleDismiss() {
    setShowModal(false)
    if (!latestEntry) return
    setShowBadge(false)
    try {
      await patchJson('/api/preferences', {
        lastSeenChangelogVersion: latestEntry.version,
      })
    } catch {
      // Fail silently
    }
  }

  if (!showBadge || !latestEntry) return null

  return (
    <>
      <button
        type="button"
        onClick={() => setShowModal(true)}
        aria-label="What's new in Cashflow"
        title="What's new"
        data-testid="whats-new-badge"
        className="inline-flex items-center gap-1 rounded-full border border-[var(--primary)] bg-[var(--primary)]/10 px-2 py-0.5 text-xs font-semibold text-[var(--primary)] hover:bg-[var(--primary)]/20 transition-colors"
      >
        <Newspaper size={12} aria-hidden="true" />
        <span>What's new</span>
      </button>

      {showModal && (
        <ChangelogModal entry={latestEntry} onDismiss={() => void handleDismiss()} />
      )}
    </>
  )
}
