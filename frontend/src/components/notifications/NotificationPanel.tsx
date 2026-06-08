import { AlertTriangle, CheckCircle2, Info, OctagonAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { Notification, NotificationSeverity } from '@/types/api'

/**
 * Popover panel for the bell (issue #266).
 *
 * - States: loading (skeleton rows), error (retry button), success
 *   (notification list or empty state).
 * - Empty state copy: "You're all caught up." (AC #11).
 * - Unread rows have a subtle left border.
 * - Each row click marks-as-read (AC #6 round-trip).
 * - "Mark all as read" CTA in the header.
 */
type Props = {
  notifications: Notification[]
  listStatus: 'idle' | 'loading' | 'success' | 'error'
  onMarkRead: (id: number) => Promise<void> | void
  onMarkAllRead: () => Promise<void> | void
  onRetry: () => Promise<void> | void
}

function severityIcon(severity: NotificationSeverity) {
  // Tailwind JIT needs literal class names — return both icon component
  // and a class string per branch so JIT picks them up.
  switch (severity) {
    case 'critical':
      return { Icon: OctagonAlert, color: 'text-red-600' }
    case 'warn':
      return { Icon: AlertTriangle, color: 'text-amber-600' }
    case 'info':
    default:
      return { Icon: Info, color: 'text-blue-600' }
  }
}

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime()
  if (!Number.isFinite(then)) return ''
  const ms = Date.now() - then
  const s = Math.floor(ms / 1000)
  if (s < 60) return 'just now'
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  if (d < 7) return `${d}d ago`
  return new Date(iso).toLocaleDateString()
}

export function NotificationPanel({
  notifications,
  listStatus,
  onMarkRead,
  onMarkAllRead,
  onRetry,
}: Props) {
  const hasUnread = notifications.some((n) => n.readAt == null)

  return (
    <div
      role="dialog"
      aria-label="Notifications"
      className="absolute right-0 mt-2 w-96 max-h-[28rem] overflow-y-auto rounded-md border border-gray-200 bg-white shadow-lg z-50"
    >
      <div className="flex items-center justify-between px-4 py-2 border-b border-gray-100">
        <h2 className="text-sm font-semibold text-gray-900">Notifications</h2>
        {hasUnread && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="text-xs text-blue-600 hover:underline"
            onClick={() => void onMarkAllRead()}
          >
            Mark all as read
          </Button>
        )}
      </div>

      {listStatus === 'loading' && (
        <ul aria-busy="true" className="divide-y divide-gray-100">
          {[0, 1, 2].map((i) => (
            <li key={i} className="px-4 py-3" data-testid="notification-skeleton">
              <div className="h-3 w-2/3 bg-gray-200 rounded mb-2 animate-pulse" />
              <div className="h-3 w-full bg-gray-100 rounded animate-pulse" />
            </li>
          ))}
        </ul>
      )}

      {listStatus === 'error' && (
        <div className="px-4 py-6 text-center text-sm text-gray-600">
          <p className="mb-3">Couldn&apos;t load notifications.</p>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="text-blue-600 hover:underline"
            onClick={() => void onRetry()}
          >
            Try again
          </Button>
        </div>
      )}

      {listStatus === 'success' && notifications.length === 0 && (
        <div className="px-4 py-10 text-center">
          <CheckCircle2
            size={28}
            className="mx-auto text-gray-400 mb-3"
            aria-hidden="true"
          />
          <p className="text-sm text-gray-600">You&apos;re all caught up.</p>
        </div>
      )}

      {listStatus === 'success' && notifications.length > 0 && (
        <ul className="divide-y divide-gray-100">
          {notifications.map((n) => {
            const { Icon, color } = severityIcon(n.severity)
            const isUnread = n.readAt == null
            return (
              <li key={n.id}>
                <Button
                  type="button"
                  variant="ghost"
                  className={`w-full text-left px-4 py-3 flex gap-3 hover:bg-gray-50 ${
                    isUnread ? 'border-l-2 border-l-blue-500' : 'border-l-2 border-l-transparent'
                  }`}
                  onClick={() => void onMarkRead(n.id)}
                  data-unread={isUnread ? 'true' : 'false'}
                >
                  <Icon size={16} className={`mt-0.5 ${color}`} aria-hidden="true" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-sm font-semibold text-gray-900 truncate">
                        {n.title}
                      </p>
                      <span className="text-[11px] text-gray-500 shrink-0">
                        {relativeTime(n.createdAt)}
                      </span>
                    </div>
                    <p className="text-xs text-gray-600 mt-0.5 line-clamp-2">
                      {n.body}
                    </p>
                  </div>
                </Button>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
