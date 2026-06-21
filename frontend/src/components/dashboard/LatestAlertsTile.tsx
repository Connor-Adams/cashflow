import { useCallback, useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { BentoTile } from './BentoTile'
import { Button } from '@connor-adams/designsystem'
import { getJson, postJson } from '@/lib/api'
import { usePushSubscription } from '@/hooks/usePushSubscription'
import { deepLinkForNotification } from '@/lib/notificationLinks'
import { DigestCard } from '@/components/notifications/DigestCard'
import type {
  Notification,
  NotificationSeverity,
  NotificationsListResponse,
} from '@/types/api'

type Status = 'loading' | 'success' | 'error'

/**
 * Dashboard tile (issue #651): "Latest alerts & this week's digest".
 *
 * Surfaces the newest unread notifications (budget breaches + the weekly
 * digest) without making the user open the bell, reusing the existing
 * `GET /api/notifications?limit=5` + `POST /api/notifications/mark-all-read`
 * endpoints. Also hosts the one-time "Enable browser alerts" web-push opt-in.
 *
 * States: loading (skeleton), error (inline retry), empty ("You're all caught
 * up"), and the populated list. The tile is always rendered (never hidden) so
 * the dashboard layout is stable.
 */

/** Literal bg classes per severity so the Tailwind JIT picks them up. */
const SEVERITY_DOT: Record<NotificationSeverity, string> = {
  info: 'bg-muted-foreground',
  warn: 'bg-warning',
  critical: 'bg-danger',
}

/** Compact relative time. Mirrors the bell panel's helper so the tile reads
 *  the same, without pulling in a date library the frontend doesn't ship. */
function relativeTime(iso: string): string {
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return ''
  const ms = Date.now() - then
  const m = Math.floor(ms / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  if (d < 7) return `${d}d ago`
  return new Date(iso).toLocaleDateString()
}

function EnableAlertsControl() {
  const { supported, permission, subscribed, busy, subscribe, unsubscribe } =
    usePushSubscription()

  // Hide entirely when the browser/server can't do push.
  if (!supported) return null

  if (permission === 'denied') {
    return (
      <Button size="sm" variant="outline" disabled>
        Blocked in browser settings
      </Button>
    )
  }

  if (subscribed) {
    return (
      <Button
        size="sm"
        variant="outline"
        disabled={busy}
        onClick={() => void unsubscribe()}
      >
        Browser alerts on
      </Button>
    )
  }

  return (
    <Button size="sm" variant="outline" disabled={busy} onClick={() => void subscribe()}>
      Enable browser alerts
    </Button>
  )
}

export function LatestAlertsTile() {
  const [status, setStatus] = useState<Status>('loading')
  const [items, setItems] = useState<Notification[]>([])
  // Deep-link from a push tap: `/?digest=expand` opens the digest card open.
  const [searchParams] = useSearchParams()
  const expandDigest = searchParams.get('digest') === 'expand'

  const load = useCallback(async () => {
    setStatus('loading')
    try {
      const res = await getJson<NotificationsListResponse>(
        '/api/notifications?limit=5&unreadOnly=true',
      )
      setItems(res.data)
      setStatus('success')
    } catch {
      setStatus('error')
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const markAllRead = useCallback(async () => {
    try {
      await postJson('/api/notifications/mark-all-read')
      setItems([])
    } catch {
      // leave the list as-is on failure; a reload will reconcile
    }
  }, [])

  const actions =
    status === 'success' && items.length > 0 ? (
      <Button size="sm" variant="ghost" onClick={() => void markAllRead()}>
        Mark all read
      </Button>
    ) : (
      <EnableAlertsControl />
    )

  return (
    <BentoTile
      span={6}
      variant="default"
      label="Latest alerts & this week's digest"
      actions={actions}
      aria-busy={status === 'loading'}
    >
      {status === 'loading' && (
        <div className="space-y-3" aria-hidden="true">
          {[0, 1, 2].map((i) => (
            <div key={i} className="space-y-1">
              <div className="h-3 w-2/3 bg-muted rounded animate-pulse" />
              <div className="h-3 w-full bg-muted rounded animate-pulse" />
            </div>
          ))}
        </div>
      )}

      {status === 'error' && (
        <div className="space-y-2">
          <p className="text-sm text-muted-foreground">Couldn't load your alerts.</p>
          <Button size="sm" variant="outline" onClick={() => void load()}>
            Retry
          </Button>
        </div>
      )}

      {status === 'success' && items.length === 0 && (
        <div className="space-y-1">
          <p className="text-sm font-semibold">You're all caught up</p>
          <p className="text-sm text-muted-foreground">
            New budget alerts and your weekly digest will show up here.
          </p>
        </div>
      )}

      {status === 'success' && items.length > 0 && (
        <ul className="space-y-3">
          {items.map((n) =>
            n.type === 'digest.weekly' ? (
              <li key={n.id}>
                <DigestCard notification={n} defaultExpanded={expandDigest} />
              </li>
            ) : (
            <li key={n.id}>
              <Link
                to={deepLinkForNotification(n)}
                className="flex gap-3 group"
              >
                <span
                  className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${SEVERITY_DOT[n.severity]}`}
                  aria-hidden="true"
                />
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline justify-between gap-2">
                    <span className="text-sm font-semibold truncate group-hover:underline">
                      {n.title}
                    </span>
                    <span className="text-xs text-muted-foreground shrink-0">
                      {relativeTime(n.createdAt)}
                    </span>
                  </span>
                  <span className="block text-sm text-muted-foreground line-clamp-2">
                    {n.body}
                  </span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </BentoTile>
  )
}
