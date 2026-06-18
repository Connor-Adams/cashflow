import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Alert } from '@/components/ui/alert'
import type { ReceiptWithItems } from '../../../shared/api-types'
import { formatMoney } from '../lib/formatMoney'
import { ItemCard } from './items/ItemCard'

type Props = {
  open: boolean
  onClose: () => void
  receipts: ReceiptWithItems[]
  categoryHints: string[]
  onExtract: (receiptId: number) => Promise<void>
}

type ReceiptPanelProps = {
  receipt: ReceiptWithItems
  categoryHints: string[]
  onExtract: (receiptId: number) => Promise<void>
}

function vendorLabel(vendor: string): string {
  if (vendor === 'uber') return 'Uber'
  if (vendor === 'uber_eats') return 'Uber Eats'
  return vendor
}

function TotalLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between text-sm text-muted-foreground">
      <span>{label}</span>
      <span>{value}</span>
    </div>
  )
}

function ReceiptPanel({ receipt, categoryHints, onExtract }: ReceiptPanelProps) {
  const [extracting, setExtracting] = useState(false)
  const [extractError, setExtractError] = useState<string | null>(null)

  async function handleExtract() {
    setExtracting(true)
    setExtractError(null)
    try {
      await onExtract(receipt.id)
    } catch (e) {
      setExtractError(e instanceof Error ? e.message : 'Extraction failed')
    } finally {
      setExtracting(false)
    }
  }

  if (receipt.externalOrderId == null || receipt.order == null) {
    return (
      <section className="space-y-2">
        <div className="text-sm font-medium">{receipt.originalName}</div>
        {extractError && <Alert variant="error">{extractError}</Alert>}
        <div className="flex items-center justify-between rounded-md border border-dashed border-border px-3 py-3">
          <span className="text-sm text-muted-foreground">No items extracted yet</span>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={extracting}
            onClick={() => void handleExtract()}
          >
            {extracting ? 'Extracting…' : 'Extract items'}
          </Button>
        </div>
      </section>
    )
  }

  const { order, items } = receipt

  return (
    <section className="space-y-2">
      <div className="flex items-baseline gap-2">
        <span className="text-sm font-medium">{vendorLabel(order.vendor)}</span>
        <span className="truncate text-xs text-muted-foreground">{receipt.originalName}</span>
      </div>

      {order.trip && (
        <div className="text-sm">
          <div>
            {order.trip.pickupAddress ?? '—'} → {order.trip.dropoffAddress ?? '—'}
          </div>
          <div className="text-muted-foreground">
            {order.trip.distance != null && `${order.trip.distance} ${order.trip.distanceUnit ?? ''}`}
            {order.trip.distance != null && order.trip.durationMinutes != null && ' · '}
            {order.trip.durationMinutes != null && `${order.trip.durationMinutes} min`}
          </div>
        </div>
      )}

      {items.length > 0 && (
        <div className="space-y-2">
          {items.map((item) => (
            <ItemCard key={item.id} item={item} categoryHints={categoryHints} currency={order.currency} />
          ))}
        </div>
      )}

      <div className="space-y-1 border-t border-border pt-2">
        {order.subtotal != null && (
          <TotalLine label="Subtotal" value={formatMoney(Number(order.subtotal), order.currency)} />
        )}
        {order.tax != null && (
          <TotalLine label="Tax" value={formatMoney(Number(order.tax), order.currency)} />
        )}
        {order.shipping != null && (
          <TotalLine label="Shipping" value={formatMoney(Number(order.shipping), order.currency)} />
        )}
        {order.total != null && (
          <div className="flex items-center justify-between text-sm font-medium">
            <span>Total</span>
            <span>{formatMoney(Number(order.total), order.currency)}</span>
          </div>
        )}
      </div>
    </section>
  )
}

export default function ReceiptItemsDrawer({
  open,
  onClose,
  receipts,
  categoryHints,
  onExtract,
}: Props) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  const itemCount = receipts.reduce((n, r) => n + (r.items?.length ?? 0), 0)

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/40" onClick={onClose} aria-hidden="true" />
      <aside
        role="dialog"
        aria-modal="true"
        aria-labelledby="receipt-items-drawer-title"
        className="fixed inset-y-0 right-0 z-50 flex w-[440px] max-w-full flex-col border-l border-border bg-card"
      >
        <header className="flex items-center justify-between border-b border-border px-4 py-3">
          <div>
            <h2 id="receipt-items-drawer-title" className="m-0 text-base font-semibold">
              Receipt items
            </h2>
            <p className="m-0 text-xs text-muted-foreground">
              {receipts.length} {receipts.length === 1 ? 'receipt' : 'receipts'} · {itemCount}{' '}
              {itemCount === 1 ? 'item' : 'items'}
            </p>
          </div>
          <Button type="button" variant="secondary" size="sm" onClick={onClose}>
            Close
          </Button>
        </header>

        <div className="flex-1 space-y-5 overflow-y-auto px-4 py-4">
          {receipts.map((receipt) => (
            <ReceiptPanel
              key={receipt.id}
              receipt={receipt}
              categoryHints={categoryHints}
              onExtract={onExtract}
            />
          ))}
        </div>
      </aside>
    </>
  )
}
