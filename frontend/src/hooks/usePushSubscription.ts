import { useCallback, useEffect, useState } from 'react'
import { postJson } from '@/lib/api'
import { getAppConfig } from '@/lib/appConfig'

/**
 * Drives the "Enable browser alerts" control (issue #651).
 *
 * Owns the browser-side web-push subscription lifecycle:
 *   - capability detection (`window.PushManager` + service-worker support),
 *   - the current `Notification.permission` state,
 *   - subscribe: requestPermission → ensure SW registered →
 *     pushManager.subscribe({ applicationServerKey }) → POST the subscription,
 *   - unsubscribe: DELETE the row server-side and drop the browser subscription.
 *
 * `supported` is false when the browser lacks PushManager (caller hides the
 * control entirely) or when the server has no VAPID key configured (push is
 * disabled end-to-end). `permission === 'denied'` is surfaced so the caller can
 * render the "Blocked in browser settings" disabled state.
 */
export type PushSubscriptionState = {
  /** Browser + server both support push (caller hides the control when false). */
  supported: boolean
  /** Current OS permission. 'denied' cannot be re-prompted. */
  permission: NotificationPermission
  /** True when an active push subscription exists for this browser. */
  subscribed: boolean
  /** A subscribe/unsubscribe round-trip is in flight. */
  busy: boolean
  /** Last error message, if the most recent action failed. */
  error: string | null
  subscribe: () => Promise<void>
  unsubscribe: () => Promise<void>
}

const SW_URL = '/sw.js'

/** Base64url → Uint8Array, per the Web Push applicationServerKey contract.
 *  Backed by a plain `ArrayBuffer` (not `ArrayBufferLike`) so it satisfies the
 *  `BufferSource` type `pushManager.subscribe` expects. */
export function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(base64)
  const buffer = new ArrayBuffer(raw.length)
  const output = new Uint8Array(buffer)
  for (let i = 0; i < raw.length; i += 1) output[i] = raw.charCodeAt(i)
  return output
}

function browserSupportsPush(): boolean {
  return (
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  )
}

async function ensureRegistration(): Promise<ServiceWorkerRegistration> {
  const existing = await navigator.serviceWorker.getRegistration(SW_URL)
  if (existing) return existing
  return navigator.serviceWorker.register(SW_URL)
}

export function usePushSubscription(): PushSubscriptionState {
  const vapidPublicKey = getAppConfig()?.vapidPublicKey ?? null
  const supported = browserSupportsPush() && Boolean(vapidPublicKey)

  const [permission, setPermission] = useState<NotificationPermission>(
    supported ? Notification.permission : 'default',
  )
  const [subscribed, setSubscribed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Reflect any existing browser subscription on mount.
  useEffect(() => {
    if (!supported) return
    let cancelled = false
    void (async () => {
      try {
        const reg = await navigator.serviceWorker.getRegistration(SW_URL)
        const sub = reg ? await reg.pushManager.getSubscription() : null
        if (!cancelled) setSubscribed(Boolean(sub))
      } catch {
        // best-effort; leave subscribed=false
      }
    })()
    return () => {
      cancelled = true
    }
  }, [supported])

  const subscribe = useCallback(async () => {
    if (!supported || !vapidPublicKey) return
    setBusy(true)
    setError(null)
    try {
      const perm = await Notification.requestPermission()
      setPermission(perm)
      if (perm !== 'granted') {
        setError('Notification permission was not granted')
        return
      }
      const reg = await ensureRegistration()
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapidPublicKey),
      })
      const json = sub.toJSON() as {
        endpoint?: string
        keys?: { p256dh?: string; auth?: string }
      }
      await postJson('/api/push/subscriptions', {
        endpoint: json.endpoint,
        keys: { p256dh: json.keys?.p256dh, auth: json.keys?.auth },
        userAgent: navigator.userAgent,
      })
      setSubscribed(true)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to enable browser alerts')
      setSubscribed(false)
    } finally {
      setBusy(false)
    }
  }, [supported, vapidPublicKey])

  const unsubscribe = useCallback(async () => {
    if (!supported) return
    setBusy(true)
    setError(null)
    try {
      const reg = await navigator.serviceWorker.getRegistration(SW_URL)
      const sub = reg ? await reg.pushManager.getSubscription() : null
      if (sub) {
        const json = sub.toJSON() as { endpoint?: string }
        if (json.endpoint) {
          // DELETE carries the endpoint in the body, which the shared
          // `deleteReq` helper doesn't support — issue the request directly.
          await fetch('/api/push/subscriptions', {
            method: 'DELETE',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ endpoint: json.endpoint }),
          })
        }
        await sub.unsubscribe()
      }
      setSubscribed(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to disable browser alerts')
    } finally {
      setBusy(false)
    }
  }, [supported])

  return { supported, permission, subscribed, busy, error, subscribe, unsubscribe }
}
