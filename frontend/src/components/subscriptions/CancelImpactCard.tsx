import { useEffect, useState } from 'react'
import { NativeSelect } from '@/components/ui/native-select'
import { getJson } from '../../lib/api'
import { formatMoney } from '../../lib/formatMoney'
import type { CancelImpact, CancelImpactHorizon } from '../../types/api'

const HORIZON_OPTIONS: ReadonlyArray<{ value: CancelImpactHorizon; label: string }> = [
  { value: 6, label: '6 months' },
  { value: 12, label: '12 months' },
  { value: 24, label: '24 months' },
]

/**
 * Inline cancel-impact preview for a single subscription (Cashflow #291).
 *
 * Fetches GET /api/subscriptions/:id/cancel-impact for the chosen horizon and
 * shows how much the user would save by cancelling. The horizon dropdown lets
 * the user switch between 6 / 12 / 24 months; changing it refetches. The
 * `refetchKey` prop (the row's current cadence) forces a refetch when the
 * cadence is corrected upstream so the figure stays in sync.
 */
export function CancelImpactCard({
  subscriptionId,
  refetchKey,
}: {
  subscriptionId: number
  /** Opaque value (the row's cadence) — changing it triggers a refetch. */
  refetchKey?: string
}) {
  const [horizon, setHorizon] = useState<CancelImpactHorizon>(12)
  const [impact, setImpact] = useState<CancelImpact | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      setLoading(true)
      setError(null)
      try {
        const res = await getJson<CancelImpact>(
          `/api/subscriptions/${subscriptionId}/cancel-impact?horizonMonths=${horizon}`,
        )
        if (!cancelled) setImpact(res)
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Error')
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [subscriptionId, horizon, refetchKey])

  return (
    <div
      className="mt-2 rounded-md bg-emerald-50 p-3 text-emerald-900"
      aria-busy={loading}
    >
      <div className="flex items-center justify-between gap-3">
        <h4 className="text-sm font-semibold">If you cancel</h4>
        <label className="flex items-center gap-1 text-xs">
          <span>Horizon</span>
          <NativeSelect
            size="sm"
            aria-label="Cancel impact horizon"
            value={String(horizon)}
            onChange={(e) =>
              setHorizon(Number(e.target.value) as CancelImpactHorizon)
            }
          >
            {HORIZON_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </NativeSelect>
        </label>
      </div>
      <p className="mt-1 text-sm">
        {error ? (
          <span className="text-destructive">
            Couldn&apos;t load cancel impact.
          </span>
        ) : impact ? (
          <>
            Cancelling saves you{' '}
            <strong>{formatMoney(impact.amount, impact.currency)}</strong> over
            the next {impact.horizonMonths} months.
          </>
        ) : (
          <span className="text-emerald-900/70">Calculating…</span>
        )}
      </p>
    </div>
  )
}
