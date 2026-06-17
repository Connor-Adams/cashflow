import { useEffect, useState } from 'react'
import { getJson } from '../lib/api'
import { formatMoney } from '../lib/formatMoney'
import type { RefundDetailsResponse } from '../types/api'

/**
 * Inline "Refund of $X at <merchant> on <date>" badge for issue #215.
 *
 * Rendered on a TransactionsPage row when `txnType === 'refund'`. The
 * component fetches /api/transactions/:id/refund-details lazily on mount so
 * the listing endpoint stays small (no N+1 join for refunds that no one
 * actually looks at). While the fetch is in-flight a non-committal "Refund"
 * pill is shown.
 *
 * States rendered:
 *   - `linkedTransactionId == null` (caller-supplied): "Refund (unlinked)"
 *   - linked but no details fetched yet: "Refund · loading…"
 *   - linked + details loaded: "Refund of $X · MERCHANT · YYYY-MM-DD"
 *   - linked but inaccessible: "Refund of linked txn (no access)"
 *   - partial (refund |amount| < original |amount|): trailing "(partial)"
 *
 * Failure modes (network, 404 on the detail route) fall back to the
 * generic "Refund (linked)" copy so a transient API issue doesn't blank
 * out the row.
 */
export function RefundBadge({
  transactionId,
  linkedTransactionId,
  currency,
}: {
  transactionId: number
  linkedTransactionId: number | null
  currency: string
}) {
  const [details, setDetails] = useState<RefundDetailsResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [errored, setErrored] = useState(false)

  useEffect(() => {
    let cancelled = false
    if (linkedTransactionId == null) {
      // No link yet — nothing to fetch.
      setDetails(null)
      return
    }
    setLoading(true)
    setErrored(false)
    getJson<RefundDetailsResponse>(`/api/transactions/${transactionId}/refund-details`)
      .then((res) => {
        if (cancelled) return
        setDetails(res)
      })
      .catch(() => {
        if (cancelled) return
        setErrored(true)
      })
      .finally(() => {
        if (cancelled) return
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [transactionId, linkedTransactionId])

  const baseClass =
    'inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium mt-1 w-fit'
  if (linkedTransactionId == null) {
    return (
      <span className={`${baseClass} bg-warning-bg text-warning`}>
        Refund (unlinked)
      </span>
    )
  }
  if (loading) {
    return (
      <span className={`${baseClass} bg-muted text-muted-foreground`}>
        Refund · loading…
      </span>
    )
  }
  if (errored || !details) {
    return (
      <span className={`${baseClass} bg-success-bg text-positive`}>
        Refund (linked)
      </span>
    )
  }
  if (!details.linked || !details.original) {
    return (
      <span className={`${baseClass} bg-muted text-muted-foreground`}>
        Refund of linked txn (no access)
      </span>
    )
  }
  const o = details.original
  const partialMark = details.partial ? ' (partial)' : ''
  return (
    <span
      className={`${baseClass} bg-success-bg text-positive`}
      title={`Refund linked to transaction #${o.id}`}
    >
      Refund of {formatMoney(Math.abs(o.amount), currency)} · {o.merchantClean} · {o.date}
      {partialMark}
    </span>
  )
}
