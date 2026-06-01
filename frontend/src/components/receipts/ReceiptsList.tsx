import { useEffect, useState } from 'react'
import { getJson } from '@/lib/api'
import { EmptyState } from '@/components/ui/empty-state'
import { formatMoney } from '@/lib/formatMoney'

export type ReceiptGroup = 'all' | 'gmail' | 'amazon' | 'other'

type ReceiptItem = {
  id: number
  title: string
  quantity: number
  unitPrice: string | null
  totalPrice: string | null
  inferredCategory: string | null
}

type ReceiptOrder = {
  id: number
  vendor: string
  source: string | null
  orderDate: string | null
  total: string | null
  currency: string
  paymentLast4: string | null
  linkStatus: 'linked' | 'needs_match' | 'orphan'
  items?: ReceiptItem[]
}

const LINK_LABEL: Record<ReceiptOrder['linkStatus'], string> = {
  linked: 'Linked',
  needs_match: 'Needs match',
  orphan: 'Orphan',
}

const LINK_COLOR: Record<ReceiptOrder['linkStatus'], string> = {
  linked: 'var(--primary)',
  needs_match: 'var(--accent-warm, var(--muted-foreground))',
  orphan: 'var(--muted-foreground)',
}

export function ReceiptsList({ group }: { group: ReceiptGroup }) {
  const [orders, setOrders] = useState<ReceiptOrder[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setOrders(null)
    setError(null)
    void (async () => {
      try {
        const data = await getJson<ReceiptOrder[]>(`/api/external-orders?group=${group}`)
        if (!cancelled) setOrders(data)
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Could not load receipts')
      }
    })()
    return () => {
      cancelled = true
    }
  }, [group])

  if (error) {
    return (
      <p className="error text-sm" role="alert">
        {error}
      </p>
    )
  }
  if (orders === null) {
    return <p className="muted text-sm">Loading receipts…</p>
  }
  if (orders.length === 0) {
    return (
      <EmptyState
        title="No receipts yet"
        description="Connect Gmail and run a scan, or import an order report, to see receipts here."
      />
    )
  }

  return (
    <ul className="flex flex-col gap-2">
      {orders.map((o) => (
        <li key={o.id}>
          <details className="rounded-md border border-border p-3">
            <summary className="flex cursor-pointer flex-wrap items-baseline justify-between gap-2">
              <span className="font-medium">{o.vendor}</span>
              <span className="muted text-sm">{o.orderDate ?? '—'}</span>
              <span className="tabular-nums">
                {o.total != null ? formatMoney(Number(o.total), o.currency) : '—'}
              </span>
              <span className="text-xs font-semibold" style={{ color: LINK_COLOR[o.linkStatus] }}>
                {LINK_LABEL[o.linkStatus]}
              </span>
              {o.source ? <span className="muted text-xs">{o.source}</span> : null}
            </summary>
            <ul className="mt-2 flex flex-col gap-1 pl-4 text-sm">
              {(o.items ?? []).map((it) => (
                <li key={it.id} className="flex justify-between gap-2">
                  <span className="truncate">
                    {it.title}
                    {it.quantity > 1 ? ` ×${it.quantity}` : ''}
                  </span>
                  <span className="muted tabular-nums">
                    {it.totalPrice != null ? formatMoney(Number(it.totalPrice), o.currency) : '—'}
                  </span>
                </li>
              ))}
              {(o.items ?? []).length === 0 ? <li className="muted">No line items</li> : null}
            </ul>
          </details>
        </li>
      ))}
    </ul>
  )
}
