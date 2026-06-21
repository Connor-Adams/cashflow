import { useEffect, useState } from 'react'
import { Button } from '@connor-adams/designsystem'
import { patchJson } from '@/lib/api'
import { useItemAllocation } from '@/hooks/useItems'
import { formatMoney } from '../../lib/formatMoney'
import type { ItemRow } from '@cashflow/shared'

type Props = {
  itemId: number | null
  item: ItemRow | null
  onClose: () => void
  onPatched: (next: Partial<ItemRow>) => void
}

export function ItemDetailDrawer({ itemId, item, onClose, onPatched }: Props) {
  const { data: alloc, loading } = useItemAllocation(itemId)
  const [categoryOverride, setCategoryOverride] = useState<string>('')
  const [businessOverride, setBusinessOverride] = useState<'unset' | 'true' | 'false'>('unset')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (item) {
      setCategoryOverride(item.categoryOverride ?? '')
      setBusinessOverride(
        item.businessUseOverride == null
          ? 'unset'
          : item.businessUseOverride
            ? 'true'
            : 'false',
      )
    }
  }, [item])

  useEffect(() => {
    if (itemId == null) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [itemId, onClose])

  if (itemId == null || !item) return null

  const save = async () => {
    setSaving(true)
    try {
      const patch: { categoryOverride?: string | null; businessUseOverride?: boolean | null } = {}
      if (categoryOverride !== (item.categoryOverride ?? '')) {
        patch.categoryOverride = categoryOverride === '' ? null : categoryOverride
      }
      const currentBiz =
        item.businessUseOverride == null
          ? 'unset'
          : item.businessUseOverride
            ? 'true'
            : 'false'
      if (businessOverride !== currentBiz) {
        patch.businessUseOverride =
          businessOverride === 'unset' ? null : businessOverride === 'true'
      }
      if (Object.keys(patch).length > 0) {
        await patchJson(`/api/external-order-items/${item.id}`, patch)
        onPatched({
          categoryOverride: patch.categoryOverride ?? null,
          categoryEffective:
            patch.categoryOverride !== undefined
              ? patch.categoryOverride ?? item.categoryEffective
              : item.categoryEffective,
          businessUseOverride:
            patch.businessUseOverride === undefined
              ? item.businessUseOverride
              : patch.businessUseOverride,
          businessUseEffective:
            patch.businessUseOverride === undefined
              ? item.businessUseEffective
              : !!patch.businessUseOverride,
        })
      }
      onClose()
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <div
        className="fixed inset-0 z-40 bg-black/40"
        onClick={onClose}
        aria-hidden="true"
      />
      <aside
        role="dialog"
        aria-label={`Item details: ${item.title}`}
        className="fixed inset-y-0 right-0 z-50 w-[480px] max-w-full overflow-y-auto border-l border-border bg-card p-4"
      >
        <header className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold">{item.title}</h2>
          <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close drawer">
            ×
          </Button>
        </header>

        <dl className="grid grid-cols-2 gap-2 text-sm">
          <dt>Vendor</dt>
          <dd>{item.order.vendor}</dd>
          <dt>Date</dt>
          <dd>{item.receipt.date ?? '—'}</dd>
          <dt>Quantity</dt>
          <dd>{item.qty}</dd>
          <dt>Unit price</dt>
          <dd>{item.unitPrice != null ? formatMoney(item.unitPrice, item.currency) : '—'}</dd>
          <dt>Total price</dt>
          <dd>{item.totalPrice != null ? formatMoney(item.totalPrice, item.currency) : '—'}</dd>
        </dl>

        <section className="mt-6">
          <h3 className="mb-2 text-sm font-medium">Category override</h3>
          <input
            aria-label="Category override"
            value={categoryOverride}
            onChange={(e) => setCategoryOverride(e.target.value)}
            placeholder={item.categoryEffective ?? 'No category'}
            className="w-full rounded border px-2 py-1 text-sm"
          />
        </section>

        <section className="mt-4">
          <h3 className="mb-2 text-sm font-medium">Business use</h3>
          <select
            aria-label="Business use override"
            value={businessOverride}
            onChange={(e) => setBusinessOverride(e.target.value as 'unset' | 'true' | 'false')}
            className="rounded border px-2 py-1 text-sm"
          >
            <option value="unset">Use inferred</option>
            <option value="true">Business</option>
            <option value="false">Personal</option>
          </select>
        </section>

        <section className="mt-6 border-t pt-4">
          <h3 className="mb-2 text-sm font-medium">Allocation</h3>
          {loading && <p className="text-sm text-muted-foreground">Loading…</p>}
          {!loading && alloc && alloc.txnId == null && (
            <p className="text-sm text-muted-foreground">Not linked to a transaction yet.</p>
          )}
          {!loading && alloc && alloc.txnId != null && (
            <dl className="grid grid-cols-2 gap-2 text-sm">
              <dt>Allocated total</dt>
              <dd>${alloc.allocatedTotal?.toFixed(2)}</dd>
              <dt>Category bucket</dt>
              <dd>{alloc.categoryBucket ?? '—'}</dd>
              <dt>Linked txn</dt>
              <dd>#{alloc.txnId}</dd>
              <dt>Txn amount</dt>
              <dd>${alloc.txnAmount?.toFixed(2)}</dd>
              <dt>% of txn</dt>
              <dd>{alloc.percentOfTxn?.toFixed(1)}%</dd>
              {alloc.linkedTxnIds.length > 1 && (
                <>
                  <dt>Also linked to</dt>
                  <dd>{alloc.linkedTxnIds.slice(1).map((id) => `#${id}`).join(', ')}</dd>
                </>
              )}
            </dl>
          )}
        </section>

        <footer className="mt-6 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => void save()} disabled={saving}>
            Save
          </Button>
        </footer>
      </aside>
    </>
  )
}
