import { useCallback, useEffect, useState } from 'react'
import { Button } from '@cashflow/ui'
import { getJson, patchJson } from '@/lib/api'
import type { ChangelogLatest } from '@/lib/changelog'
import { ChangelogModal } from './ChangelogModal'

export function WhatsNewBell() {
  const [latest, setLatest] = useState<ChangelogLatest | null>(null)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    let active = true
    getJson<ChangelogLatest>('/api/changelog/latest')
      .then((r) => { if (active) setLatest(r) })
      .catch(() => { /* non-critical surface: stay silent on failure */ })
    return () => { active = false }
  }, [])

  const acknowledge = useCallback(async () => {
    const version = latest?.version
    setOpen(false)
    setLatest((curr) => (curr ? { ...curr, unread: false } : curr))
    if (!version) return
    try {
      await patchJson('/api/changelog/seen', { version })
    } catch {
      /* best-effort; badge already cleared locally */
    }
  }, [latest])

  if (!latest || latest.empty || !latest.version) return null
  const unread = latest.unread === true

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="relative inline-flex items-center"
        onClick={() => setOpen(true)}
        data-testid="whats-new-pill"
      >
        What&apos;s new
        {unread && (
          <span
            className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-danger"
            aria-label="New release notes"
            data-testid="whats-new-badge"
          />
        )}
      </Button>
      <ChangelogModal
        open={open}
        title={latest.title ?? "What's new"}
        html={latest.html ?? ''}
        onAcknowledge={acknowledge}
        onClose={() => setOpen(false)}
      />
    </>
  )
}
