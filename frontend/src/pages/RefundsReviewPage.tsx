import { useCallback, useEffect, useState } from 'react'
import { Button } from '@connor-adams/designsystem'
import { Card } from '@connor-adams/designsystem'
import { PageHeader } from '@/components/ui/page-header'
import { useToast } from '@/components/ui/toast'
import { deleteReq, getJson, postJson } from '../lib/api'
import { formatMoney } from '../lib/formatMoney'
import type {
  RefundSuggestionRow,
  RefundSuggestionsResponse,
  Transaction,
} from '../types/api'

/**
 * Refunds review queue page (issue #215).
 *
 * Lists refunds the detector either auto-linked (and you haven't reviewed) or
 * surfaced as canonical-brand suggestions. Each row supports three actions:
 *   - Confirm: accepts the current link, marks the row reviewed, drops it
 *     from the queue.
 *   - Switch to: accepts a suggested-original instead. Internally a DELETE
 *     of the current link followed by a POST of the new link.
 *   - Unlink: removes the link entirely (useful when neither the auto nor
 *     suggested match is right).
 *
 * The page is intentionally minimal — no pagination, no filters — because
 * the queue itself is bounded (the backend caps at 200 rows). When the
 * volume grows we can add filters then.
 */
export function RefundsReviewPage() {
  const { showToast } = useToast()
  const [loading, setLoading] = useState(true)
  const [rows, setRows] = useState<RefundSuggestionRow[]>([])
  const [busyId, setBusyId] = useState<number | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await getJson<RefundSuggestionsResponse>(
        '/api/transactions/refund-suggestions',
      )
      setRows(res.data)
    } catch (err) {
      showToast({
        title: 'Failed to load refund suggestions',
        description: err instanceof Error ? err.message : String(err),
        variant: 'destructive',
      })
    } finally {
      setLoading(false)
    }
  }, [showToast])

  useEffect(() => {
    void load()
  }, [load])

  const confirmCurrent = useCallback(
    async (row: RefundSuggestionRow) => {
      if (!row.linkedOriginal) return
      setBusyId(row.refundId)
      try {
        // Re-POST the existing link — backend stamps reviewedAt and clears
        // reviewFlag so the row drops out of the queue on the next load.
        await postJson<Transaction>(
          `/api/transactions/${row.refundId}/refund-link`,
          { originalTransactionId: row.linkedOriginal.id },
        )
        showToast({ title: 'Refund link confirmed' })
        await load()
      } catch (err) {
        showToast({
          title: 'Failed to confirm link',
          description: err instanceof Error ? err.message : String(err),
          variant: 'destructive',
        })
      } finally {
        setBusyId(null)
      }
    },
    [load, showToast],
  )

  const switchToSuggestion = useCallback(
    async (row: RefundSuggestionRow, originalId: number) => {
      setBusyId(row.refundId)
      try {
        await postJson<Transaction>(
          `/api/transactions/${row.refundId}/refund-link`,
          { originalTransactionId: originalId },
        )
        showToast({ title: 'Refund link updated' })
        await load()
      } catch (err) {
        showToast({
          title: 'Failed to switch link',
          description: err instanceof Error ? err.message : String(err),
          variant: 'destructive',
        })
      } finally {
        setBusyId(null)
      }
    },
    [load, showToast],
  )

  const unlink = useCallback(
    async (row: RefundSuggestionRow) => {
      setBusyId(row.refundId)
      try {
        await deleteReq(`/api/transactions/${row.refundId}/refund-link`)
        showToast({ title: 'Refund unlinked' })
        await load()
      } catch (err) {
        showToast({
          title: 'Failed to unlink',
          description: err instanceof Error ? err.message : String(err),
          variant: 'destructive',
        })
      } finally {
        setBusyId(null)
      }
    },
    [load, showToast],
  )

  return (
    <div className="space-y-6">
      <PageHeader
        title="Refunds review"
        description="Refunds the detector tied back to a purchase. Confirm, switch to a suggested match, or unlink."
        actions={
          <Button
            type="button"
            variant="secondary"
            onClick={() => void load()}
            disabled={loading}
          >
            {loading ? 'Loading…' : 'Refresh'}
          </Button>
        }
      />
      {loading && rows.length === 0 ? (
        <p className="text-sm leading-6 text-muted-foreground">
          Loading refund queue…
        </p>
      ) : rows.length === 0 ? (
        <Card className="p-6">
          <p className="text-sm leading-6 text-muted-foreground">
            No refunds need review. New refunds appear here automatically when
            the detector auto-links them, or when a canonical-brand suggestion
            needs human confirmation.
          </p>
        </Card>
      ) : (
        <ul className="space-y-4">
          {rows.map((row) => (
            <RefundReviewItem
              key={row.refundId}
              row={row}
              busy={busyId === row.refundId}
              onConfirm={() => void confirmCurrent(row)}
              onSwitch={(originalId) => void switchToSuggestion(row, originalId)}
              onUnlink={() => void unlink(row)}
            />
          ))}
        </ul>
      )}
    </div>
  )
}

function RefundReviewItem({
  row,
  busy,
  onConfirm,
  onSwitch,
  onUnlink,
}: {
  row: RefundSuggestionRow
  busy: boolean
  onConfirm: () => void
  onSwitch: (originalId: number) => void
  onUnlink: () => void
}) {
  return (
    <li className="border rounded-md p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <p className="font-medium">
            {row.refundMerchantClean} ·{' '}
            {formatMoney(row.refundAmount, row.refundCurrency)}
          </p>
          <p className="text-sm text-muted-foreground">{row.refundDate}</p>
        </div>
        <div className="text-sm text-muted-foreground">
          {row.autoSource ?? 'manual'} · {row.autoConfidence ?? 'n/a'}
        </div>
      </div>
      {row.linkedOriginal && (
        <div className="mt-3 text-sm">
          <p className="text-muted-foreground">Currently linked to:</p>
          <p>
            #{row.linkedOriginal.id} · {row.linkedOriginal.merchantClean} ·{' '}
            {formatMoney(
              Math.abs(row.linkedOriginal.amount),
              row.linkedOriginal.currency,
            )}{' '}
            on {row.linkedOriginal.date}
          </p>
        </div>
      )}
      {row.suggestions.length > 0 && (
        <div className="mt-3 text-sm">
          <p className="text-muted-foreground">Other possible matches:</p>
          <ul className="space-y-1">
            {row.suggestions.map((s) => (
              <li
                key={s.originalId}
                className="flex flex-wrap items-center gap-2"
              >
                <span>
                  #{s.originalId} · {s.originalMerchantClean} ·{' '}
                  {formatMoney(
                    Math.abs(s.originalAmount),
                    s.originalCurrency,
                  )}{' '}
                  on {s.originalDate}
                </span>
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  disabled={busy}
                  onClick={() => onSwitch(s.originalId)}
                >
                  Switch to this
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="mt-4 flex flex-wrap gap-2">
        {row.linkedOriginal && (
          <Button type="button" disabled={busy} onClick={onConfirm}>
            Confirm
          </Button>
        )}
        {(row.linkedOriginal || row.suggestions.length > 0) && (
          <Button
            type="button"
            variant="secondary"
            disabled={busy}
            onClick={onUnlink}
          >
            Unlink
          </Button>
        )}
      </div>
    </li>
  )
}

