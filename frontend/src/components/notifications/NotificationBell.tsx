import { useCallback, useEffect, useRef, useState } from 'react'
import { Bell } from 'lucide-react'
import { Button } from '@connor-adams/designsystem'
import { useNotifications } from '@/hooks/useNotifications'
import { NotificationPanel } from './NotificationPanel'

/**
 * Top-bar bell icon that surfaces unread notifications (issue #266).
 *
 * - Renders a Bell + an unread badge capped at "99+" (AC #10).
 * - Click toggles a popover anchored to the bell that lists the latest
 *   20 notifications via `loadList()` from the hook.
 * - Closes on outside-click and on Escape — keyboard-accessible.
 * - On error (count fetch fails), shows a red dot but the rest of the UI
 *   keeps working.
 */
export function NotificationBell() {
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const {
    unreadCount,
    countStatus,
    notifications,
    listStatus,
    loadList,
    markRead,
    markAllRead,
  } = useNotifications()

  const toggle = useCallback(() => {
    setOpen((wasOpen) => {
      const willOpen = !wasOpen
      if (willOpen) void loadList()
      return willOpen
    })
  }, [loadList])

  // Outside-click + Escape close.
  useEffect(() => {
    if (!open) return
    const onClick = (e: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setOpen(false)
      }
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('mousedown', onClick)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onClick)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  const badgeLabel = unreadCount > 99 ? '99+' : String(unreadCount)
  const showBadge = unreadCount > 0

  return (
    <div ref={containerRef} className="relative">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        aria-label="Notifications"
        title="Notifications"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={toggle}
        className="relative inline-flex items-center justify-center rounded-full w-9 h-9"
      >
        <Bell size={18} aria-hidden="true" />
        {showBadge && (
          <span
            className="absolute -top-0.5 -right-0.5 min-w-[18px] h-[18px] px-1 rounded-full bg-danger text-white text-[10px] font-semibold flex items-center justify-center"
            data-testid="notification-badge"
          >
            {badgeLabel}
          </span>
        )}
        {countStatus === 'error' && !showBadge && (
          <span
            className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-danger"
            aria-label="Failed to load notifications"
            data-testid="notification-error-dot"
          />
        )}
      </Button>

      {open && (
        <NotificationPanel
          notifications={notifications}
          listStatus={listStatus}
          onMarkRead={markRead}
          onMarkAllRead={markAllRead}
          onRetry={loadList}
        />
      )}
    </div>
  )
}
