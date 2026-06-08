import { useState } from 'react'
import { Button } from '@/components/ui/button'
import type { ReceiptWithItems } from '../../../shared/api-types'
import { formatMoney } from '../lib/formatMoney'
import { ItemRow } from './items/ItemRow'

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
      <div style={{ marginBottom: '1rem', padding: '0.75rem', border: '1px solid var(--border)', borderRadius: '4px' }}>
        <div style={{ marginBottom: '0.5rem' }}>
          <strong>{receipt.originalName}</strong>
        </div>
        {extractError && (
          <p role="alert" style={{ color: 'var(--destructive)', marginBottom: '0.5rem' }}>
            {extractError}
          </p>
        )}
        <Button
          type="button"
          variant="secondary"
          disabled={extracting}
          onClick={() => void handleExtract()}
        >
          {extracting ? 'Extracting…' : 'Extract items'}
        </Button>
      </div>
    )
  }

  const { order, items } = receipt

  return (
    <div style={{ marginBottom: '1.5rem' }}>
      <div style={{ marginBottom: '0.5rem' }}>
        <strong>{order.vendor === 'uber' ? 'Uber' : order.vendor === 'uber_eats' ? 'Uber Eats' : order.vendor}</strong>{' '}
        <span style={{ color: 'var(--muted-foreground)' }}>{receipt.originalName}</span>
      </div>

      {order.trip && (
        <div style={{ marginBottom: '0.5rem', fontSize: '0.9rem', color: 'var(--foreground)' }}>
          <div>
            {order.trip.pickupAddress ?? '—'} → {order.trip.dropoffAddress ?? '—'}
          </div>
          <div style={{ color: 'var(--muted-foreground)' }}>
            {order.trip.distance != null && `${order.trip.distance} ${order.trip.distanceUnit ?? ''}`}
            {order.trip.distance != null && order.trip.durationMinutes != null && ' · '}
            {order.trip.durationMinutes != null && `${order.trip.durationMinutes} min`}
          </div>
        </div>
      )}

      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            <th>Item</th>
            <th>Qty</th>
            <th>Total</th>
            <th>Category</th>
            <th>Business %</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <ItemRow key={item.id} item={item} categoryHints={categoryHints} currency={order.currency} />
          ))}
        </tbody>
        <tfoot>
          {order.subtotal != null && (
            <tr>
              <td colSpan={4}>Subtotal</td>
              <td>{formatMoney(Number(order.subtotal), order.currency)}</td>
            </tr>
          )}
          {order.tax != null && (
            <tr>
              <td colSpan={4}>Tax</td>
              <td>{formatMoney(Number(order.tax), order.currency)}</td>
            </tr>
          )}
          {order.shipping != null && (
            <tr>
              <td colSpan={4}>Shipping</td>
              <td>{formatMoney(Number(order.shipping), order.currency)}</td>
            </tr>
          )}
          {order.total != null && (
            <tr>
              <td colSpan={4}>Total</td>
              <td>{formatMoney(Number(order.total), order.currency)}</td>
            </tr>
          )}
        </tfoot>
      </table>
    </div>
  )
}

export default function ReceiptItemsDrawer({
  open,
  onClose,
  receipts,
  categoryHints,
  onExtract,
}: Props) {
  if (!open) return null

  return (
    <div className="receiptItemsDrawer" role="dialog" aria-modal="true" aria-labelledby="receipt-items-drawer-title">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
        <h2 id="receipt-items-drawer-title" style={{ margin: 0 }}>Receipt Items</h2>
        <Button type="button" variant="secondary" onClick={onClose}>
          Close
        </Button>
      </div>

      {receipts.map((receipt) => (
        <ReceiptPanel
          key={receipt.id}
          receipt={receipt}
          categoryHints={categoryHints}
          onExtract={onExtract}
        />
      ))}
    </div>
  )
}
