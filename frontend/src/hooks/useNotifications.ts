import { useCallback, useEffect, useRef, useState } from 'react'
import { getJson } from '@/lib/api'
import type {
  Notification,
  NotificationsListResponse,
  NotificationUnreadCountResponse,
} from '@/types/api'

const POLL_MS = 60 * 1000

type Status = 'idle' | 'loading' | 'success' | 'error'

/**
 * Drives the TopBar notification bell (issue #266).
 *
 * Polls `/unread-count` every minute (and on window-focus) so the bell badge
 * reflects new notifications without WebSockets. When the user opens the
 * panel, we fetch the latest 20 from `/api/notifications` and surface them.
 *
 * `markRead(id)` and `markAllRead()` write-through to the server and
 * optimistically update local state so the count drops the instant the
 * user interacts. A subsequent poll reconciles the truth.
 */
export function useNotifications(): {
  unreadCount: number
  countStatus: Status
  notifications: Notification[]
  listStatus: Status
  loadList: () => Promise<void>
  markRead: (id: number) => Promise<void>
  markAllRead: () => Promise<void>
} {
  const [unreadCount, setUnreadCount] = useState(0)
  const [countStatus, setCountStatus] = useState<Status>('idle')
  const [notifications, setNotifications] = useState<Notification[]>([])
  const [listStatus, setListStatus] = useState<Status>('idle')
  const cancelledRef = useRef(false)

  const fetchUnread = useCallback(async () => {
    setCountStatus((s) => (s === 'success' ? s : 'loading'))
    try {
      const r = await getJson<NotificationUnreadCountResponse>(
        '/api/notifications/unread-count',
      )
      if (cancelledRef.current) return
      setUnreadCount(r.count)
      setCountStatus('success')
    } catch {
      if (cancelledRef.current) return
      setCountStatus('error')
    }
  }, [])

  const loadList = useCallback(async () => {
    setListStatus('loading')
    try {
      const r = await getJson<NotificationsListResponse>(
        '/api/notifications?limit=20',
      )
      if (cancelledRef.current) return
      setNotifications(r.data)
      setListStatus('success')
    } catch {
      if (cancelledRef.current) return
      setListStatus('error')
    }
  }, [])

  const markRead = useCallback(async (id: number) => {
    // Optimistic: drop from unread immediately.
    setNotifications((curr) =>
      curr.map((n) =>
        n.id === id && n.readAt == null
          ? { ...n, readAt: new Date().toISOString() }
          : n,
      ),
    )
    setUnreadCount((c) => Math.max(0, c - 1))
    try {
      await fetch(
        `${import.meta.env.VITE_API_BASE ?? ''}/api/notifications/${id}/read`,
        { method: 'POST', credentials: 'include' },
      )
    } catch {
      // Best-effort. Next poll reconciles.
    }
  }, [])

  const markAllRead = useCallback(async () => {
    setNotifications((curr) =>
      curr.map((n) =>
        n.readAt == null ? { ...n, readAt: new Date().toISOString() } : n,
      ),
    )
    setUnreadCount(0)
    try {
      await fetch(
        `${import.meta.env.VITE_API_BASE ?? ''}/api/notifications/mark-all-read`,
        { method: 'POST', credentials: 'include' },
      )
    } catch {
      // Best-effort. Next poll reconciles.
    }
  }, [])

  useEffect(() => {
    cancelledRef.current = false
    void fetchUnread()
    const interval = setInterval(() => void fetchUnread(), POLL_MS)
    const onFocus = () => void fetchUnread()
    window.addEventListener('focus', onFocus)
    return () => {
      cancelledRef.current = true
      clearInterval(interval)
      window.removeEventListener('focus', onFocus)
    }
  }, [fetchUnread])

  return {
    unreadCount,
    countStatus,
    notifications,
    listStatus,
    loadList,
    markRead,
    markAllRead,
  }
}
