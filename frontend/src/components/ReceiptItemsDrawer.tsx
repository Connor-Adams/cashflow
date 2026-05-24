import { useState } from 'react'
import { patchJson } from '../lib/api'
import type { ReceiptWithItems, ExternalOrderItemView } from '../../../shared/api-types'

type Props = {
  open: boolean
  onClose: () => void
  receipts: ReceiptWithItems[]
  categoryHints: string[]
  onExtract: (receiptId: number) => Promise<void>
}

type ItemRowProps = {
  item: ExternalOrderItemView
  categoryHints: string[]
}

function ItemRow({ item, categoryHints }: ItemRowProps) {
  const initialCategory = item.categoryOverride ?? item.inferredCategory ?? ''
  const initialBusiness = item.businessUseOverride ?? item.businessUsePercent ?? ''

  const [category, setCategory] = useState(initialCategory)
  const [business, setBusiness] = useState(initialBusiness)

  async function handleCategoryBlur() {
    if (category === initialCategory) return
    await patchJson(`/api/external-order-items/${item.id}`, {
      categoryOverride: category === '' ? null : category,
    })
  }

  async function handleBusinessBlur() {
    if (business === initialBusiness) return
    const val = business === '' ? null : Number(business)
    await patchJson(`/api/external-order-items/${item.id}`, {
      businessUseOverride: val,
    })
  }

  return (
    <tr>
      <td>{item.title}</td>
      <td>{item.quantity}</td>
      <td>{item.totalPrice ?? '—'}</td>
      <td>
        <select
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          onBlur={() => void handleCategoryBlur()}
        >
          <option value="">(uncategorized)</option>
          {categoryHints.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </td>
      <td>
        <input
          type="number"
          min={0}
          max={100}
          value={business}
          onChange={(e) => setBusiness(e.target.value)}
          onBlur={() => void handleBusinessBlur()}
        />
      </td>
    </tr>
  )
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
      <div style={{ marginBottom: '1rem', padding: '0.75rem', border: '1px solid #ddd', borderRadius: '4px' }}>
        <div style={{ marginBottom: '0.5rem' }}>
          <strong>{receipt.originalName}</strong>
        </div>
        {extractError && (
          <p role="alert" style={{ color: 'red', marginBottom: '0.5rem' }}>
            {extractError}
          </p>
        )}
        <button
          type="button"
          disabled={extracting}
          onClick={() => void handleExtract()}
        >
          {extracting ? 'Extracting…' : 'Extract items'}
        </button>
      </div>
    )
  }

  const { order, items } = receipt

  return (
    <div style={{ marginBottom: '1.5rem' }}>
      <div style={{ marginBottom: '0.5rem' }}>
        <strong>{order.vendor}</strong>{' '}
        <span style={{ color: '#666' }}>{receipt.originalName}</span>
      </div>

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
            <ItemRow key={item.id} item={item} categoryHints={categoryHints} />
          ))}
        </tbody>
        <tfoot>
          {order.subtotal != null && (
            <tr>
              <td colSpan={4}>Subtotal</td>
              <td>{order.subtotal}</td>
            </tr>
          )}
          {order.tax != null && (
            <tr>
              <td colSpan={4}>Tax</td>
              <td>{order.tax}</td>
            </tr>
          )}
          {order.shipping != null && (
            <tr>
              <td colSpan={4}>Shipping</td>
              <td>{order.shipping}</td>
            </tr>
          )}
          {order.total != null && (
            <tr>
              <td colSpan={4}>Total</td>
              <td>{order.total}</td>
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
    <div className="receiptItemsDrawer" role="dialog" aria-modal="true">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
        <h2 style={{ margin: 0 }}>Receipt Items</h2>
        <button type="button" onClick={onClose}>
          Close
        </button>
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
