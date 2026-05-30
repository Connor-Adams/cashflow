import { useCallback, useEffect, useState } from 'react'
import { Card } from '@/components/ui/card'
import { EmptyState } from '@/components/ui/empty-state'
import { Skeleton } from '@/components/ui/skeleton'
import { useToast } from '@/components/ui/toast'
import { getJson, patchJson } from '@/lib/api'
import type {
  NotificationPreference,
  NotificationPreferencesListResponse,
} from '@/types/api'

/**
 * Settings → Notifications tab (issue #266, AC #12).
 *
 * Lists every known notification type with In-app + Email checkboxes.
 * Toggling either checkbox PATCHes the preference row. Types that don't
 * yet have a row come back with the defaults (`channelInApp=true,
 * channelEmail=false`) — toggling lazily creates the row server-side.
 *
 * "Known" types come from two server-side sources (merged): explicit
 * preference rows + any notification rows the user has ever received.
 * If a user has never received anything yet, this list is empty and we
 * show a helpful empty state — there's nothing useful to show until at
 * least one event has fired.
 */

function humanizeType(type: string): string {
  // 'budget.breach' → 'Budget breach'
  // 'subscription.price_change' → 'Subscription price change'
  return type
    .replace(/[._]/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
}

export function NotificationsTab() {
  const [prefs, setPrefs] = useState<NotificationPreference[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const toast = useToast()

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const r = await getJson<NotificationPreferencesListResponse>(
        '/api/users/me/notifications/preferences',
      )
      setPrefs(r.data)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load preferences')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const toggle = useCallback(
    async (
      type: string,
      field: 'channelInApp' | 'channelEmail',
      next: boolean,
    ) => {
      // Optimistic update.
      setPrefs((curr) =>
        curr.map((p) => (p.type === type ? { ...p, [field]: next } : p)),
      )
      try {
        const saved = await patchJson<NotificationPreference>(
          `/api/users/me/notifications/preferences/${encodeURIComponent(type)}`,
          { [field]: next },
        )
        setPrefs((curr) => curr.map((p) => (p.type === type ? saved : p)))
      } catch (e) {
        // Roll back on failure.
        setPrefs((curr) =>
          curr.map((p) => (p.type === type ? { ...p, [field]: !next } : p)),
        )
        toast.showToast({
          variant: 'destructive',
          title: 'Failed to update preference',
          description: e instanceof Error ? e.message : 'Try again',
        })
      }
    },
    [toast],
  )

  return (
    <Card className="settingsCard">
      <h2 className="settingsCard__title">Notifications</h2>
      <p className="settingsCard__description">
        Choose how you receive notifications for each event type. Email
        delivery is coming soon — the preference is saved now and will start
        sending when the email channel is enabled.
      </p>

      {loading && (
        <div data-testid="notifications-loading" className="space-y-2 mt-4">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      )}

      {error && !loading && (
        <div className="mt-4 text-sm text-red-600">
          <p>{error}</p>
          <button
            type="button"
            className="mt-2 text-blue-600 hover:underline"
            onClick={() => void load()}
          >
            Try again
          </button>
        </div>
      )}

      {!loading && !error && prefs.length === 0 && (
        <EmptyState
          title="No notification types yet"
          description="Once you start receiving notifications (budget breaches, insights, subscription changes), you'll be able to fine-tune per-type channels here."
        />
      )}

      {!loading && !error && prefs.length > 0 && (
        <table className="w-full mt-4 text-sm">
          <thead>
            <tr className="text-left text-gray-500 border-b border-gray-100">
              <th className="py-2">Type</th>
              <th className="py-2 text-center w-24">In-app</th>
              <th className="py-2 text-center w-24">Email</th>
            </tr>
          </thead>
          <tbody>
            {prefs.map((p) => (
              <tr
                key={p.type}
                className="border-b border-gray-50"
                data-testid={`pref-row-${p.type}`}
              >
                <td className="py-2 font-medium text-gray-800">
                  {humanizeType(p.type)}
                </td>
                <td className="py-2 text-center">
                  <input
                    type="checkbox"
                    aria-label={`In-app for ${p.type}`}
                    checked={p.channelInApp}
                    onChange={(e) =>
                      void toggle(p.type, 'channelInApp', e.target.checked)
                    }
                  />
                </td>
                <td className="py-2 text-center">
                  <input
                    type="checkbox"
                    aria-label={`Email for ${p.type}`}
                    checked={p.channelEmail}
                    onChange={(e) =>
                      void toggle(p.type, 'channelEmail', e.target.checked)
                    }
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  )
}
