/**
 * Purchase intelligence page (issue #218).
 *
 * Two regions:
 *   1. "Large purchases inbox" — transactions >= $500 (configurable) that
 *      haven't been promoted to a tracked purchase. One-click "Track this
 *      purchase" starts a profile.
 *   2. "Tracked purchases" — filterable list (all / large / missing-docs /
 *      business) with an inline detail drawer for editing the profile.
 *
 * Stays intentionally compact: forms reuse the existing UI primitives, and
 * cost-per-month-owned comes pre-computed from the backend so the FE just
 * formats it.
 */
import { useMemo, useState } from 'react'
import type { ChangeEvent, FormEvent } from 'react'
import { Inbox, Plus, Trash2, X } from 'lucide-react'
import { Badge } from '@cashflow/ui'
import { Button } from '@cashflow/ui'
import { Card } from '@cashflow/ui'
import { useConfirm } from '@cashflow/ui'
import { EmptyState, EmptyTableRow } from '@cashflow/ui'
import { Input } from '@cashflow/ui'
import { Label } from '@cashflow/ui'
import { NativeSelect } from '@cashflow/ui'
import { PageHeader } from '@/components/ui/page-header'
import { SkeletonRow } from '@cashflow/ui'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@cashflow/ui'
import { Textarea } from '@cashflow/ui'
import { useToast } from '@/components/ui/toast'
import { formatMoney } from '../lib/formatMoney'
import {
  PURCHASE_FILTERS,
  PURCHASE_RECEIPT_STATUSES,
  PURCHASE_WARRANTY_STATUSES,
  useLargeInbox,
  usePurchases,
  upsertPurchase,
  untrackPurchase,
  type PurchaseDto,
  type PurchaseFilter,
  type PurchasePatch,
  type PurchaseReceiptStatus,
  type PurchaseWarrantyStatus,
} from '@/hooks/usePurchases'

const RECEIPT_BADGE: Record<PurchaseReceiptStatus, string> = {
  unknown: 'bg-muted text-muted-foreground',
  missing: 'bg-warning-bg text-warning-foreground',
  saved: 'bg-success-bg text-success-foreground',
}

const WARRANTY_BADGE: Record<PurchaseWarrantyStatus, string> = {
  unknown: 'bg-muted text-muted-foreground',
  none: 'bg-muted text-muted-foreground',
  active: 'bg-success-bg text-success-foreground',
  expired: 'bg-danger-bg text-danger',
}

const DEFAULT_LARGE_THRESHOLD = 500

export function PurchasesPage() {
  const [filter, setFilter] = useState<PurchaseFilter>('all')
  const [minAmount, setMinAmount] = useState<number>(DEFAULT_LARGE_THRESHOLD)
  const [selected, setSelected] = useState<PurchaseDto | null>(null)
  const { showToast } = useToast()
  const confirm = useConfirm()

  const listArgs = useMemo(
    () => ({ filter, minAmount }),
    [filter, minAmount],
  )
  const { data, loading, error, refresh } = usePurchases(listArgs)

  const inboxArgs = useMemo(() => ({ minAmount }), [minAmount])
  const {
    data: inbox,
    loading: inboxLoading,
    refresh: refreshInbox,
  } = useLargeInbox(inboxArgs)

  async function quickTrack(transactionId: number) {
    try {
      await upsertPurchase(transactionId, { receiptStatus: 'unknown' })
      showToast({ title: 'Purchase tracked', variant: 'success' })
      await Promise.all([refresh(), refreshInbox()])
    } catch (e) {
      showToast({
        title: e instanceof Error ? e.message : 'Failed to track purchase',
        variant: 'destructive',
      })
    }
  }

  async function handleSave(transactionId: number, patch: PurchasePatch) {
    try {
      const updated = await upsertPurchase(transactionId, patch)
      setSelected(updated)
      showToast({ title: 'Purchase updated', variant: 'success' })
      await refresh()
    } catch (e) {
      showToast({
        title: e instanceof Error ? e.message : 'Failed to save',
        variant: 'destructive',
      })
    }
  }

  async function handleUntrack(transactionId: number) {
    const ok = await confirm({
      title: 'Untrack this purchase?',
      description: 'The transaction will remain. Only the purchase profile is removed.',
      confirmLabel: 'Untrack',
    })
    if (!ok) return
    try {
      await untrackPurchase(transactionId)
      setSelected(null)
      await Promise.all([refresh(), refreshInbox()])
      showToast({ title: 'Purchase untracked', variant: 'success' })
    } catch (e) {
      showToast({
        title: e instanceof Error ? e.message : 'Failed to untrack',
        variant: 'destructive',
      })
    }
  }

  return (
    <div className="page">
      <PageHeader
        title="Purchases"
        description="Promote major purchases into tracked records. See cost per month owned, warranty status, and which need documentation."
      />

      <LargeInboxCard
        minAmount={minAmount}
        onMinAmountChange={setMinAmount}
        loading={inboxLoading}
        rows={inbox?.data ?? []}
        onTrack={quickTrack}
      />

      <Card className="flex flex-col gap-3 p-4">
        <div className="flex flex-wrap items-center gap-3">
          <Label htmlFor="purchase-filter" className="text-sm font-medium">
            Filter
          </Label>
          <NativeSelect
            id="purchase-filter"
            value={filter}
            onChange={(e) => setFilter(e.target.value as PurchaseFilter)}
          >
            {PURCHASE_FILTERS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </NativeSelect>
          {filter === 'large' && (
            <div className="flex items-center gap-2">
              <Label htmlFor="purchase-min" className="text-sm">
                Min $
              </Label>
              <Input
                id="purchase-min"
                type="number"
                value={String(minAmount)}
                onChange={(e: ChangeEvent<HTMLInputElement>) =>
                  setMinAmount(Math.max(0, Number(e.target.value) || 0))
                }
                className="w-24"
                min={0}
              />
            </div>
          )}
          <span className="ml-auto text-sm text-muted-foreground">
            {data?.count ?? 0} tracked
          </span>
        </div>

        {error && (
          <div className="rounded border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
            {error}
          </div>
        )}

        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Date</TableHead>
              <TableHead>Merchant</TableHead>
              <TableHead>Account</TableHead>
              <TableHead className="text-right">Amount</TableHead>
              <TableHead className="text-right">Cost / month</TableHead>
              <TableHead>Receipt</TableHead>
              <TableHead>Warranty</TableHead>
              <TableHead></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading && (
              <SkeletonRow cols={8} />
            )}
            {!loading && (data?.data ?? []).length === 0 && (
              <EmptyTableRow
                colSpan={8}
                title="No tracked purchases yet"
                description="Mark a transaction as a purchase to start tracking its lifecycle."
              />
            )}
            {!loading &&
              (data?.data ?? []).map((p) => (
                <TableRow key={p.transactionId}>
                  <TableCell>{p.transaction.date}</TableCell>
                  <TableCell>
                    <Button
                      type="button"
                      variant="link"
                      className="text-left"
                      onClick={() => setSelected(p)}
                    >
                      {p.transaction.merchant}
                    </Button>
                  </TableCell>
                  <TableCell>{p.transaction.accountName ?? '—'}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatMoney(
                      Math.abs(Number(p.transaction.amount) || 0),
                      p.transaction.currency,
                    )}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatMoney(p.costPerMonth, p.transaction.currency)}
                    <span className="ml-1 text-xs text-muted-foreground">
                      ({p.monthsOwned}m)
                    </span>
                  </TableCell>
                  <TableCell>
                    <Badge className={RECEIPT_BADGE[p.receiptStatus]}>
                      {p.receiptStatus}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <Badge className={WARRANTY_BADGE[p.warrantyStatus]}>
                      {p.warrantyStatus}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => setSelected(p)}
                    >
                      Open
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
          </TableBody>
        </Table>
      </Card>

      {selected && (
        <PurchaseDetailDrawer
          purchase={selected}
          onClose={() => setSelected(null)}
          onSave={handleSave}
          onUntrack={handleUntrack}
        />
      )}
    </div>
  )
}

// ----- Large-purchase inbox card -----------------------------------------

function LargeInboxCard({
  minAmount,
  onMinAmountChange,
  loading,
  rows,
  onTrack,
}: {
  minAmount: number
  onMinAmountChange: (v: number) => void
  loading: boolean
  rows: Array<{
    id: number
    date: string
    merchant: string
    amount: string
    currency: string
    accountName: string | null
  }>
  onTrack: (id: number) => void
}) {
  return (
    <Card className="flex flex-col gap-3 p-4">
      <div className="flex flex-wrap items-center gap-3">
        <Inbox aria-hidden="true" className="text-muted-foreground" />
        <h2 className="text-lg font-semibold">Large purchase inbox</h2>
        <div className="flex items-center gap-2">
          <Label htmlFor="inbox-min" className="text-sm">
            ≥ $
          </Label>
          <Input
            id="inbox-min"
            type="number"
            value={String(minAmount)}
            onChange={(e: ChangeEvent<HTMLInputElement>) =>
              onMinAmountChange(Math.max(0, Number(e.target.value) || 0))
            }
            className="w-24"
            min={0}
          />
        </div>
        <span className="ml-auto text-sm text-muted-foreground">
          {rows.length} candidate{rows.length === 1 ? '' : 's'}
        </span>
      </div>
      {!loading && rows.length === 0 && (
        <EmptyState
          title="Inbox empty"
          description={`No unmarked transactions ≥ $${minAmount}.`}
        />
      )}
      {rows.length > 0 && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Date</TableHead>
              <TableHead>Merchant</TableHead>
              <TableHead>Account</TableHead>
              <TableHead className="text-right">Amount</TableHead>
              <TableHead></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={r.id}>
                <TableCell>{r.date}</TableCell>
                <TableCell>{r.merchant}</TableCell>
                <TableCell>{r.accountName ?? '—'}</TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatMoney(Math.abs(Number(r.amount) || 0), r.currency)}
                </TableCell>
                <TableCell>
                  <Button
                    type="button"
                    size="sm"
                    onClick={() => onTrack(r.id)}
                  >
                    <Plus aria-hidden="true" className="mr-1 h-3 w-3" />
                    Track
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Card>
  )
}

// ----- Detail drawer -----------------------------------------------------

function PurchaseDetailDrawer({
  purchase,
  onClose,
  onSave,
  onUntrack,
}: {
  purchase: PurchaseDto
  onClose: () => void
  onSave: (transactionId: number, patch: PurchasePatch) => Promise<void>
  onUntrack: (transactionId: number) => Promise<void>
}) {
  const [draft, setDraft] = useState<PurchasePatch>({
    receiptStatus: purchase.receiptStatus,
    warrantyStatus: purchase.warrantyStatus,
    warrantyExpiresAt: purchase.warrantyExpiresAt,
    warrantyProvider: purchase.warrantyProvider,
    businessRelevant: purchase.businessRelevant,
    usefulLifeMonths: purchase.usefulLifeMonths,
    notes: purchase.notes,
  })

  function update<K extends keyof PurchasePatch>(key: K, value: PurchasePatch[K]) {
    setDraft((prev) => ({ ...prev, [key]: value }))
  }

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    await onSave(purchase.transactionId, draft)
  }

  return (
    <div
      className="fixed inset-0 z-40 flex items-stretch justify-end bg-black/30"
      onClick={onClose}
    >
      <Card
        className="flex w-full max-w-lg flex-col gap-4 overflow-y-auto p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between">
          <div>
            <h3 className="text-lg font-semibold">{purchase.transaction.merchant}</h3>
            <p className="text-sm text-muted-foreground">
              {purchase.transaction.date} —{' '}
              {formatMoney(
                Math.abs(Number(purchase.transaction.amount) || 0),
                purchase.transaction.currency,
              )}
              {' • '}
              {purchase.transaction.accountName ?? 'no account'}
              {purchase.transaction.finalCategory
                ? ` • ${purchase.transaction.finalCategory}`
                : ''}
            </p>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onClose}
            aria-label="Close detail panel"
          >
            <X aria-hidden="true" />
          </Button>
        </div>

        <div className="grid grid-cols-2 gap-3 rounded border bg-muted/30 p-3 text-sm">
          <div>
            <div className="text-xs uppercase text-muted-foreground">Cost / month</div>
            <div className="font-semibold tabular-nums">
              {formatMoney(purchase.costPerMonth, purchase.transaction.currency)}
            </div>
          </div>
          <div>
            <div className="text-xs uppercase text-muted-foreground">Months owned</div>
            <div className="font-semibold tabular-nums">{purchase.monthsOwned}</div>
          </div>
        </div>

        <form className="flex flex-col gap-3" onSubmit={handleSubmit}>
          <div>
            <Label htmlFor="purchase-receipt-status">Receipt status</Label>
            <NativeSelect
              id="purchase-receipt-status"
              value={draft.receiptStatus ?? 'unknown'}
              onChange={(e) =>
                update('receiptStatus', e.target.value as PurchaseReceiptStatus)
              }
            >
              {PURCHASE_RECEIPT_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </NativeSelect>
          </div>

          <div>
            <Label htmlFor="purchase-warranty-status">Warranty status</Label>
            <NativeSelect
              id="purchase-warranty-status"
              value={draft.warrantyStatus ?? 'unknown'}
              onChange={(e) =>
                update('warrantyStatus', e.target.value as PurchaseWarrantyStatus)
              }
            >
              {PURCHASE_WARRANTY_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </NativeSelect>
          </div>

          <div>
            <Label htmlFor="purchase-warranty-expires">Warranty expires</Label>
            <Input
              id="purchase-warranty-expires"
              type="date"
              value={draft.warrantyExpiresAt ?? ''}
              onChange={(e) =>
                update(
                  'warrantyExpiresAt',
                  e.target.value === '' ? null : e.target.value,
                )
              }
            />
          </div>

          <div>
            <Label htmlFor="purchase-warranty-provider">Warranty provider</Label>
            <Input
              id="purchase-warranty-provider"
              type="text"
              value={draft.warrantyProvider ?? ''}
              onChange={(e) =>
                update(
                  'warrantyProvider',
                  e.target.value === '' ? null : e.target.value,
                )
              }
              maxLength={256}
            />
          </div>

          <div>
            <Label htmlFor="purchase-useful-life">Useful life (months)</Label>
            <Input
              id="purchase-useful-life"
              type="number"
              min={1}
              max={600}
              value={draft.usefulLifeMonths != null ? String(draft.usefulLifeMonths) : ''}
              onChange={(e) => {
                const raw = e.target.value
                if (raw === '') update('usefulLifeMonths', null)
                else update('usefulLifeMonths', Number(raw) || null)
              }}
            />
            <p className="mt-1 text-xs text-muted-foreground">
              Used to amortise cost-per-month while the asset is younger than its declared life.
            </p>
          </div>

          <div>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={Boolean(draft.businessRelevant)}
                onChange={(e) => update('businessRelevant', e.target.checked)}
              />
              Business-relevant
            </label>
          </div>

          <div>
            <Label htmlFor="purchase-notes">Notes</Label>
            <Textarea
              id="purchase-notes"
              value={draft.notes ?? ''}
              onChange={(e) =>
                update('notes', e.target.value === '' ? null : e.target.value)
              }
              maxLength={4000}
              rows={3}
            />
          </div>

          <div className="mt-2 flex items-center justify-between">
            <Button
              type="button"
              variant="destructive"
              size="sm"
              onClick={() => void onUntrack(purchase.transactionId)}
            >
              <Trash2 aria-hidden="true" className="mr-1 h-3 w-3" />
              Untrack
            </Button>
            <div className="flex gap-2">
              <Button type="button" variant="ghost" onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit">Save</Button>
            </div>
          </div>
        </form>
      </Card>
    </div>
  )
}
