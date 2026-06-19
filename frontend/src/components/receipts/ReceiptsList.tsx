import { useEffect, useState } from 'react'
import { getJson } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { Skeleton } from '@/components/ui/skeleton'
import { formatMoney } from '@/lib/formatMoney'
import {
  summarizeOrders,
  rollUpCategories,
  type ReceiptOrder,
  type ReceiptLinkStatus,
} from './receiptDerivations'

export type ReceiptGroup = 'all' | 'gmail' | 'amazon' | 'other'

const LINK_LABEL: Record<ReceiptLinkStatus, string> = {
  linked: 'Linked',
  needs_match: 'Needs match',
  orphan: 'Orphan',
}

const LINK_COLOR: Record<ReceiptLinkStatus, string> = {
  linked: 'var(--positive)',
  needs_match: 'var(--primary)',
  orphan: 'var(--warning)',
}

// Distinct swatches for the per-receipt category roll-up bar (cycled if needed).
const CAT_COLORS = [
  'var(--primary)',
  'var(--positive)',
  'var(--warning)',
  'var(--chart-3)',
  'var(--muted-foreground)',
  'var(--border)',
]

// Single source of truth for the column template so header + every row align.
const ROW_GRID = 'grid grid-cols-[1.6fr_0.7fr_1fr_1fr_auto_1rem] items-center gap-3'

export function ReceiptsList({
  group,
  onUploadClick,
  onClearGroup,
}: {
  group: ReceiptGroup
  /** Invoked by the empty-state CTA when there are no receipts at all — the
   *  parent surfaces the upload/forward UI (e.g. scroll to the Gmail card). */
  onUploadClick?: () => void
  /** Invoked when the active group filter excludes everything — resets to the
   *  "all" group so the user can see whatever receipts exist. */
  onClearGroup?: () => void
}) {
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
    return (
      <ul className="flex flex-col gap-1" aria-hidden>
        {Array.from({ length: 6 }, (_, i) => (
          <li key={`receipts-skeleton-${i}`} className={`${ROW_GRID} rounded-md border border-border px-3 py-2`}>
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-4 w-16" />
            <Skeleton className="ml-auto h-4 w-12" />
            <Skeleton className="ml-auto h-4 w-16" />
            <Skeleton className="mx-auto h-2 w-2 rounded-full" />
            <Skeleton className="h-4 w-3" />
          </li>
        ))}
      </ul>
    )
  }
  if (orders.length === 0) {
    // A non-"all" group with zero rows means the filter excludes everything,
    // not that the user has no receipts — disambiguate the CTA (#799).
    if (group !== 'all') {
      return (
        <EmptyState
          title="Nothing matches this filter"
          description="No receipts in this group. Clear the filter to see everything."
          actions={
            onClearGroup ? (
              <Button size="sm" variant="outline" onClick={onClearGroup}>
                Clear filters
              </Button>
            ) : undefined
          }
        />
      )
    }
    return (
      <EmptyState
        title="No receipts yet"
        description="Forward emailed receipts or upload them, and we'll match them to your card transactions."
        actions={
          onUploadClick ? (
            <Button size="sm" onClick={onUploadClick}>
              Upload a receipt
            </Button>
          ) : undefined
        }
      />
    )
  }

  const summary = summarizeOrders(orders)
  const currency = orders[0].currency
  // Total/tax sums only make sense in a single currency; the list can mix them.
  const singleCurrency = orders.every((o) => o.currency === currency)

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-[var(--muted-foreground)]">
        <span>
          <strong className="text-[var(--foreground)]">{summary.count}</strong> receipts
        </span>
        {summary.orphanCount > 0 ? (
          <>
            <span aria-hidden>·</span>
            <span>
              <strong style={{ color: 'var(--warning)' }}>{summary.orphanCount}</strong>{' '}
              {summary.orphanCount === 1 ? 'orphan' : 'orphans'}
            </span>
          </>
        ) : null}
        {singleCurrency ? (
          <>
            <span aria-hidden>·</span>
            <span className="tabular-nums">
              <strong className="text-[var(--foreground)]">{formatMoney(summary.totalSum, currency)}</strong> total
            </span>
          </>
        ) : null}
        {singleCurrency && summary.taxSum > 0 ? (
          <>
            <span aria-hidden>·</span>
            <span className="tabular-nums">
              <strong className="text-[var(--foreground)]">{formatMoney(summary.taxSum, currency)}</strong> tax
            </span>
          </>
        ) : null}
      </div>

      <div className={`${ROW_GRID} px-3 text-[10px] uppercase tracking-wide text-[var(--muted-foreground)]`}>
        <span>Vendor</span>
        <span>Date</span>
        <span className="text-right">Tax</span>
        <span className="text-right">Total</span>
        <span className="sr-only">Status</span>
        <span aria-hidden />
      </div>

      <ul className="flex flex-col gap-1">
        {orders.map((o) => {
          const cats = rollUpCategories(o.items ?? [])
          const catTotal = cats.reduce((sum, c) => sum + c.total, 0)
          const items = o.items ?? []
          return (
            <li key={o.id}>
              <details className="group rounded-md border border-border">
                <summary className={`${ROW_GRID} cursor-pointer list-none px-3 py-2 [&::-webkit-details-marker]:hidden`}>
                  <span className="truncate font-medium">{o.vendor}</span>
                  <span className="muted text-sm tabular-nums">{o.orderDate ?? '—'}</span>
                  <span className="muted text-right text-sm tabular-nums">
                    {o.tax != null ? formatMoney(Number(o.tax), o.currency) : ''}
                  </span>
                  <span className="text-right tabular-nums">
                    {o.total != null ? formatMoney(Number(o.total), o.currency) : '—'}
                  </span>
                  <span className="flex justify-center">
                    <span
                      className="inline-block h-2 w-2 rounded-full"
                      style={{ background: LINK_COLOR[o.linkStatus] }}
                      title={LINK_LABEL[o.linkStatus]}
                    />
                    <span className="sr-only">{LINK_LABEL[o.linkStatus]}</span>
                  </span>
                  <span aria-hidden className="text-[var(--muted-foreground)] transition-transform group-open:rotate-90">›</span>
                </summary>

                <div className="flex flex-col gap-3 border-t border-border bg-[var(--card)] p-3 sm:flex-row sm:gap-6">
                  <div className="min-w-0 flex-1">
                    <p className="mb-1 text-[10px] uppercase tracking-wide text-[var(--muted-foreground)]">
                      {items.length} items
                    </p>
                    <ul className="flex max-h-40 flex-col gap-1 overflow-y-auto pr-1 text-sm">
                      {items.map((it) => (
                        <li key={it.id} className="flex justify-between gap-2">
                          <span className="truncate">
                            {it.title}
                            {it.quantity > 1 ? ` ×${it.quantity}` : ''}
                          </span>
                          <span
                            className="muted tabular-nums"
                            style={
                              it.totalPrice != null && Number(it.totalPrice) < 0
                                ? { color: 'var(--warning)' }
                                : undefined
                            }
                          >
                            {it.totalPrice != null ? formatMoney(Number(it.totalPrice), o.currency) : '—'}
                          </span>
                        </li>
                      ))}
                      {items.length === 0 ? <li className="muted">No line items</li> : null}
                    </ul>
                  </div>

                  <div className="sm:w-56">
                    <p className="mb-1 text-[10px] uppercase tracking-wide text-[var(--muted-foreground)]">Breakdown</p>
                    <dl className="text-sm">
                      {o.subtotal != null ? (
                        <div className="flex justify-between gap-2 py-0.5 text-[var(--muted-foreground)]">
                          <dt>Subtotal</dt>
                          <dd className="tabular-nums text-[var(--foreground)]">{formatMoney(Number(o.subtotal), o.currency)}</dd>
                        </div>
                      ) : null}
                      {o.tax != null ? (
                        <div className="flex justify-between gap-2 py-0.5 text-[var(--muted-foreground)]">
                          <dt>Tax</dt>
                          <dd className="tabular-nums text-[var(--foreground)]">{formatMoney(Number(o.tax), o.currency)}</dd>
                        </div>
                      ) : null}
                      {o.shipping != null ? (
                        <div className="flex justify-between gap-2 py-0.5 text-[var(--muted-foreground)]">
                          <dt>Shipping</dt>
                          <dd className="tabular-nums text-[var(--foreground)]">{formatMoney(Number(o.shipping), o.currency)}</dd>
                        </div>
                      ) : null}
                      <div className="mt-1 flex justify-between gap-2 border-t border-border pt-2 font-semibold">
                        <dt>Total</dt>
                        <dd className="tabular-nums">
                          {o.total != null ? formatMoney(Number(o.total), o.currency) : '—'}
                        </dd>
                      </div>
                    </dl>
                    {o.paymentLast4 ? (
                      <p className="mt-2 text-xs text-[var(--muted-foreground)]">
                        Paid with{' '}
                        <span className="rounded border border-border px-1.5 py-0.5 text-[var(--foreground)]">•••• {o.paymentLast4}</span>
                      </p>
                    ) : null}

                    {cats.length > 0 ? (
                      <div className="mt-3 border-t border-border pt-2">
                        <p className="mb-1.5 text-[10px] uppercase tracking-wide text-[var(--muted-foreground)]">Where it went</p>
                        <div className="mb-2 flex h-2 overflow-hidden rounded">
                          {cats.map((c, i) => (
                            <span
                              key={c.category}
                              style={{ width: `${(c.total / catTotal) * 100}%`, background: CAT_COLORS[i % CAT_COLORS.length] }}
                            />
                          ))}
                        </div>
                        <ul className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-[var(--muted-foreground)]">
                          {cats.map((c, i) => (
                            <li key={c.category} className="flex items-center gap-1.5">
                              <span
                                className="inline-block h-2 w-2 rounded-sm"
                                style={{ background: CAT_COLORS[i % CAT_COLORS.length] }}
                              />
                              {c.category}{' '}
                              <span className="tabular-nums text-[var(--foreground)]">{formatMoney(c.total, o.currency)}</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    ) : null}
                  </div>
                </div>
              </details>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
