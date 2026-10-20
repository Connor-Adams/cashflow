import { useCallback, useEffect, useState } from 'react'
import { getJson, patchJson } from '@/lib/api'
import { usePushSubscription } from '@/hooks/usePushSubscription'
import { getAppConfig } from '@/lib/appConfig'
import type {
  NotificationPreference,
  NotificationPreferencesListResponse,
} from '@/types/api'

/**
 * Notification preferences settings (issues #266 / #651 / #796).
 *
 * Lists each known notification type with per-channel toggles. Every toggle
 * shown must actually do something:
 *  - In-app and push are independent channels for every type.
 *  - Email is shown ONLY for the weekly digest — it is the only type that
 *    sends email (`runWeeklyDigest`); the generic dispatcher never does. It is
 *    disabled, with a hint, when the server has no mailer configured
 *    (`/api/config` → `emailConfigured: false`).
 *  - Push is disabled, with the reason, when the server can't send push or
 *    the browser can't receive it. Turning push on subscribes this browser
 *    first (via `usePushSubscription`), so the toggle is never an empty
 *    preference with no endpoint behind it.
 * The digest additionally exposes a send-day picker (#796). Saves via
 * `PATCH /api/users/me/notifications/preferences/:type` with optimistic UI and
 * an inline error fallback that reverts on failure.
 */

/** The only notification type that has an email channel. */
const EMAIL_CAPABLE_TYPE = 'digest.weekly'

const DAYS: { value: number; label: string }[] = [
  { value: 0, label: 'Sunday' },
  { value: 1, label: 'Monday' },
  { value: 2, label: 'Tuesday' },
  { value: 3, label: 'Wednesday' },
  { value: 4, label: 'Thursday' },
  { value: 5, label: 'Friday' },
  { value: 6, label: 'Saturday' },
]

const TYPE_LABELS: Record<string, { label: string; sub?: string }> = {
  'digest.weekly': {
    label: 'Weekly spend digest',
    sub: 'A summary of spend, insights, and what’s coming up.',
  },
  'budget.breach': { label: 'Budget alerts' },
  'job.failed': {
    label: 'Background job failures',
    sub: 'When a scheduled or manual job run fails.',
  },
}

function Toggle({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean
  onChange: (next: boolean) => void
  label: string
  disabled?: boolean
}) {
  return (
    <label className="inline-flex items-center gap-1.5 text-sm">
      <input
        type="checkbox"
        className="size-4 rounded border-border"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className={disabled ? 'text-muted-foreground' : 'text-foreground'}>{label}</span>
    </label>
  )
}

export function NotificationsTab() {
  const [prefs, setPrefs] = useState<NotificationPreference[]>([])
  const [status, setStatus] = useState<'loading' | 'success' | 'error'>('loading')
  const [rowError, setRowError] = useState<Record<string, string>>({})
  const push = usePushSubscription()
  const pushBlocked = push.permission === 'denied'
  const pushUnavailableReason = !push.serverConfigured
    ? 'Push notifications aren’t set up on this server.'
    : !push.browserSupported
      ? 'This browser doesn’t support push notifications.'
      : pushBlocked
        ? 'Push blocked in your browser. Enable notifications in your browser settings to receive push.'
        : null
  const pushDisabled = pushUnavailableReason !== null || push.busy
  // Missing config (failed /api/config load) reads as "not configured".
  const emailConfigured = getAppConfig()?.emailConfigured === true

  const load = useCallback(async () => {
    setStatus('loading')
    try {
      const res = await getJson<NotificationPreferencesListResponse>(
        '/api/users/me/notifications/preferences',
      )
      setPrefs(res.data)
      setStatus('success')
    } catch {
      setStatus('error')
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const save = useCallback(
    async (type: string, patch: Partial<NotificationPreference>) => {
      const prev = prefs
      // Optimistic update.
      setPrefs((cur) => cur.map((p) => (p.type === type ? { ...p, ...patch } : p)))
      setRowError((e) => {
        const next = { ...e }
        delete next[type]
        return next
      })
      try {
        const saved = await patchJson<NotificationPreference>(
          `/api/users/me/notifications/preferences/${type}`,
          patch,
        )
        setPrefs((cur) => cur.map((p) => (p.type === type ? saved : p)))
      } catch {
        // Revert and show the inline error.
        setPrefs(prev)
        setRowError((e) => ({ ...e, [type]: 'Couldn’t save your digest settings. Try again.' }))
      }
    },
    [prefs],
  )

  const togglePush = useCallback(
    async (type: string, next: boolean) => {
      // Turning push on is meaningless without a browser subscription for
      // the server to send to — create one first, and only save on success.
      if (next && !push.subscribed) {
        const ok = await push.subscribe()
        if (!ok) {
          setRowError((e) => ({
            ...e,
            [type]: 'Couldn’t enable push in this browser. Check your notification permission and try again.',
          }))
          return
        }
      }
      await save(type, { channelPush: next } as Partial<NotificationPreference>)
    },
    [push, save],
  )

  if (status === 'loading') {
    return (
      <div className="space-y-2" aria-busy="true">
        {[0, 1].map((i) => (
          <div key={i} className="h-16 animate-pulse rounded-md bg-muted" />
        ))}
      </div>
    )
  }

  if (status === 'error') {
    return (
      <div className="space-y-2">
        <p className="text-sm text-muted-foreground">Couldn’t load notification settings.</p>
        <button
          type="button"
          className="text-sm text-info hover:underline"
          onClick={() => void load()}
        >
          Try again
        </button>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-foreground">Notifications</h2>
        <p className="text-sm text-muted-foreground">
          Choose how each kind of notification reaches you.
        </p>
      </div>

      {pushUnavailableReason && (
        <p className="text-xs text-warning">{pushUnavailableReason}</p>
      )}

      <ul className="space-y-3">
        {prefs.map((p) => {
          const meta = TYPE_LABELS[p.type] ?? { label: p.type }
          const isDigest = p.type === 'digest.weekly'
          const hasEmail = p.type === EMAIL_CAPABLE_TYPE
          return (
            <li key={p.type} className="rounded-md border border-border bg-card p-4">
              <div className="mb-2">
                <p className="text-sm font-medium text-foreground">{meta.label}</p>
                {meta.sub && <p className="text-xs text-muted-foreground">{meta.sub}</p>}
              </div>

              <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                <Toggle
                  label="In-app"
                  checked={p.channelInApp}
                  onChange={(v) => void save(p.type, { channelInApp: v } as Partial<NotificationPreference>)}
                />
                {hasEmail && (
                  <>
                    <Toggle
                      label="Email"
                      checked={p.channelEmail && emailConfigured}
                      disabled={!emailConfigured}
                      onChange={(v) => void save(p.type, { channelEmail: v } as Partial<NotificationPreference>)}
                    />
                    {!emailConfigured && (
                      <span className="text-xs text-muted-foreground">
                        Email isn’t set up on this server.
                      </span>
                    )}
                  </>
                )}
                <Toggle
                  label="Push"
                  checked={p.channelPush && pushUnavailableReason === null}
                  disabled={pushDisabled}
                  onChange={(v) => void togglePush(p.type, v)}
                />
                {isDigest && (
                  <label className="inline-flex items-center gap-1.5 text-sm">
                    <span className="text-muted-foreground">Send on</span>
                    <select
                      className="rounded-md border border-border bg-background px-2 py-1 text-sm"
                      value={p.digestDayOfWeek}
                      onChange={(e) =>
                        void save(p.type, {
                          digestDayOfWeek: Number(e.target.value),
                        } as Partial<NotificationPreference>)
                      }
                      aria-label="Digest send day"
                    >
                      {DAYS.map((d) => (
                        <option key={d.value} value={d.value}>
                          {d.label}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
              </div>

              {rowError[p.type] && (
                <p className="mt-2 text-xs text-danger">{rowError[p.type]}</p>
              )}
            </li>
          )
        })}
      </ul>
    </div>
  )
}
