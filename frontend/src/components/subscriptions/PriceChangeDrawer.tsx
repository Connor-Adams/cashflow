/**
 * Drawer/dialog that shows pending price-change records for a subscription
 * and lets the user acknowledge them (issue #441).
 */
import { useEffect, useState } from 'react'
import { X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { useToast } from '@/components/ui/toast'
import { getJson, postJson } from '@/lib/api'
import { formatMoney } from '@/lib/formatMoney'

type PriceChangeRecord = {
  id: number
  subscriptionId: number
  merchantName: string
  previousAmount: string
  newAmount: string
  currency: string
  detectedOn: string
}

type Props = {
  subscriptionId: number
  merchantName: string
  onClose: () => void
  onAcknowledged: () => void
}

export function PriceChangeDrawer({
  subscriptionId,
  merchantName,
  onClose,
  onAcknowledged,
}: Props) {
  const { showToast } = useToast()
  const [records, setRecords] = useState<PriceChangeRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [ackingId, setAckingId] = useState<number | null>(null)

  useEffect(() => {
    let cancelled = false
    async function load() {
      setLoading(true)
      try {
        const res = await getJson<{ data: PriceChangeRecord[] }>(
          '/api/subscriptions/price-changes',
        )
        if (!cancelled) {
          setRecords(res.data.filter((r) => r.subscriptionId === subscriptionId))
        }
      } catch (e) {
        if (!cancelled) {
          showToast({
            title: e instanceof Error ? e.message : 'Failed to load price changes',
            variant: 'destructive',
          })
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void load()
    return () => { cancelled = true }
  }, [subscriptionId, showToast])

  async function acknowledge(id: number) {
    setAckingId(id)
    try {
      await postJson(`/api/subscriptions/price-changes/${id}/acknowledge`)
      setRecords((prev) => prev.filter((r) => r.id !== id))
      showToast({ title: 'Price change acknowledged', variant: 'success' })
      if (records.length <= 1) {
        // All changes acknowledged — close and trigger refresh.
        onAcknowledged()
      }
    } catch (e) {
      showToast({
        title: e instanceof Error ? e.message : 'Could not acknowledge',
        variant: 'destructive',
      })
    } finally {
      setAckingId(null)
    }
  }

  const prev = records[0] ? Number(records[0].previousAmount) : null
  const next = records[0] ? Number(records[0].newAmount) : null
  const currency = records[0]?.currency ?? ''
  const pctChange =
    prev && next && prev !== 0
      ? (((next - prev) / Math.abs(prev)) * 100).toFixed(1)
      : null

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Price change details for ${merchantName}`}
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/40 p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <Card className="w-full max-w-md p-5">
        <div className="flex items-start justify-between mb-4">
          <div>
            <h2 className="text-lg font-semibold">Price change</h2>
            <p className="text-sm text-muted-foreground">{merchantName}</p>
          </div>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground"
          >
            <X size={18} />
          </button>
        </div>

        {loading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : records.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No pending price changes — all caught up.
          </p>
        ) : (
          <div className="space-y-3">
            {records.map((r) => (
              <div
                key={r.id}
                className="rounded-md border border-input p-3 space-y-2"
              >
                <div className="text-sm">
                  <div className="flex gap-4">
                    <span className="text-muted-foreground">Was</span>
                    <span>{formatMoney(Number(r.previousAmount), r.currency)}</span>
                  </div>
                  <div className="flex gap-4">
                    <span className="text-muted-foreground">Now</span>
                    <span className="font-medium text-destructive">
                      {formatMoney(Number(r.newAmount), r.currency)}
                    </span>
                  </div>
                  {pctChange && (
                    <div className="text-xs text-muted-foreground">
                      +{pctChange}% increase
                    </div>
                  )}
                  <div className="text-xs text-muted-foreground mt-1">
                    Detected {r.detectedOn}
                  </div>
                </div>
                <Button
                  type="button"
                  size="sm"
                  disabled={ackingId != null}
                  onClick={() => void acknowledge(r.id)}
                >
                  {ackingId === r.id ? 'Acknowledging…' : 'Acknowledge'}
                </Button>
              </div>
            ))}
          </div>
        )}

        {!loading && records.length === 0 && (
          <div className="mt-4 flex justify-end">
            <Button type="button" variant="outline" size="sm" onClick={onClose}>
              Close
            </Button>
          </div>
        )}

        {prev !== null && next !== null && (
          <p className="text-xs text-muted-foreground mt-4">
            New monthly estimate:{' '}
            <strong>{formatMoney(next, currency)}</strong> vs previous{' '}
            {formatMoney(prev, currency)}.
          </p>
        )}
      </Card>
    </div>
  )
}
