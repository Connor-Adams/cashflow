import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Alert } from '@/components/ui/alert'
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '@/components/ui/table'
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
      <Card className="mb-4 space-y-2 p-3">
        <strong>{receipt.originalName}</strong>
        {extractError && <Alert variant="error">{extractError}</Alert>}
        <div>
          <Button
            type="button"
            variant="secondary"
            disabled={extracting}
            onClick={() => void handleExtract()}
          >
            {extracting ? 'Extracting…' : 'Extract items'}
          </Button>
        </div>
      </Card>
    )
  }

  const { order, items } = receipt

  return (
    <div className="mb-6">
      <div className="mb-2">
        <strong>{order.vendor === 'uber' ? 'Uber' : order.vendor === 'uber_eats' ? 'Uber Eats' : order.vendor}</strong>{' '}
        <span className="text-muted-foreground">{receipt.originalName}</span>
      </div>

      {order.trip && (
        <div className="mb-2 text-sm">
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

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Item</TableHead>
            <TableHead>Qty</TableHead>
            <TableHead>Total</TableHead>
            <TableHead>Category</TableHead>
            <TableHead>Business %</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map((item) => (
            <ItemRow key={item.id} item={item} categoryHints={categoryHints} currency={order.currency} />
          ))}
        </TableBody>
        <tfoot>
          {order.subtotal != null && (
            <TableRow>
              <TableCell colSpan={4}>Subtotal</TableCell>
              <TableCell>{formatMoney(Number(order.subtotal), order.currency)}</TableCell>
            </TableRow>
          )}
          {order.tax != null && (
            <TableRow>
              <TableCell colSpan={4}>Tax</TableCell>
              <TableCell>{formatMoney(Number(order.tax), order.currency)}</TableCell>
            </TableRow>
          )}
          {order.shipping != null && (
            <TableRow>
              <TableCell colSpan={4}>Shipping</TableCell>
              <TableCell>{formatMoney(Number(order.shipping), order.currency)}</TableCell>
            </TableRow>
          )}
          {order.total != null && (
            <TableRow>
              <TableCell colSpan={4}>Total</TableCell>
              <TableCell>{formatMoney(Number(order.total), order.currency)}</TableCell>
            </TableRow>
          )}
        </tfoot>
      </Table>
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
    <div role="dialog" aria-modal="true" aria-labelledby="receipt-items-drawer-title">
      <div className="mb-4 flex items-center justify-between">
        <h2 id="receipt-items-drawer-title" className="m-0 text-lg font-semibold">
          Receipt Items
        </h2>
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
