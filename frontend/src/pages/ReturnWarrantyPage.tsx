/**
 * Return-window and warranty tracker. Lets users see purchases still inside
 * the return window, warranty-covered purchases, and purchases missing a
 * receipt. The "Edit" row dialog patches the per-transaction metadata via
 * PATCH /api/transactions/:id/return-warranty.
 *
 * The page is intentionally simple: three tabs, one table per tab, one shared
 * edit dialog. Heavier query/filter UX can come later — the bones go in first.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { AlertTriangle, CalendarClock, ShieldCheck } from 'lucide-react'
import { Alert } from '@cashflow/ui'
import { Badge } from '@cashflow/ui'
import { Button } from '@cashflow/ui'
import { Card } from '@cashflow/ui'
import { EmptyTableRow } from '@cashflow/ui'
import { Input } from '@cashflow/ui'
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
import { Tabs, TabPanel } from '@cashflow/ui'
import { useToast } from '@/components/ui/toast'
import { getJson, patchJson } from '../lib/api'
import { formatMoneyOr } from '../lib/formatMoney'
import type {
  ReceiptStatus,
  ReturnWarrantyRowView,
  ReturnWarrantyListResponse,
  ReturnMetadataPatchResponse,
} from '../types/returnWarranty'

const RECEIPT_STATUS_OPTIONS: ReadonlyArray<{
  value: ReceiptStatus
  label: string
}> = [
  { value: 'unknown', label: 'Unknown' },
  { value: 'have', label: 'I have it' },
  { value: 'missing', label: 'Missing' },
  { value: 'not_needed', label: 'Not needed' },
]

/**
 * Tailwind variant lookup for receipt-status badges. Listed as literal class
 * names so the JIT compiler doesn't strip them.
 */
const RECEIPT_STATUS_VARIANT: Record<
  ReceiptStatus,
  'default' | 'secondary' | 'outline' | 'destructive'
> = {
  unknown: 'outline',
  have: 'default',
  missing: 'destructive',
  not_needed: 'secondary',
}

type TabKey = 'active' | 'expiring' | 'warranties' | 'missing'

const TAB_ITEMS = [
  { value: 'active', label: 'Active returns' },
  { value: 'expiring', label: 'Expiring soon' },
  { value: 'warranties', label: 'Warranty-covered' },
  { value: 'missing', label: 'Missing receipts' },
] as const

const COLUMN_COUNT = 7

export function ReturnWarrantyPage() {
  const { showToast } = useToast()
  const [tab, setTab] = useState<TabKey>('active')
  const [rows, setRows] = useState<ReturnWarrantyRowView[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [editing, setEditing] = useState<ReturnWarrantyRowView | null>(null)
  const [expiringDays, setExpiringDays] = useState<number>(7)

  const endpointForTab = useCallback(
    (which: TabKey): string => {
      switch (which) {
        case 'active':
          return '/api/return-warranty/active'
        case 'expiring':
          return `/api/return-warranty/expiring-soon?days=${expiringDays}`
        case 'warranties':
          return '/api/return-warranty/warranties'
        case 'missing':
          return '/api/return-warranty/missing-receipts'
      }
    },
    [expiringDays],
  )

  const refresh = useCallback(async () => {
    setLoading(true)
    setErr(null)
    try {
      const res = await getJson<ReturnWarrantyListResponse>(endpointForTab(tab))
      setRows(res.data)
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed to load')
    } finally {
      setLoading(false)
    }
  }, [endpointForTab, tab])

  useEffect(() => {
    void refresh()
  }, [refresh])

  async function savePatch(
    txnId: number,
    patch: {
      returnDeadline?: string | null
      warrantyEndDate?: string | null
      receiptStatus?: ReceiptStatus
      notes?: string | null
    },
  ) {
    try {
      await patchJson<ReturnMetadataPatchResponse>(
        `/api/transactions/${txnId}/return-warranty`,
        patch,
      )
      showToast({ title: 'Saved', variant: 'success' })
      setEditing(null)
      await refresh()
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Save failed'
      showToast({ title: message, variant: 'destructive' })
    }
  }

  return (
    <div className="page">
      <PageHeader
        title="Returns & warranties"
        description="Track which purchases can still be returned, which are warranty-covered, and which are missing a receipt."
      />

      <div className="mb-4">
        <Tabs
          items={TAB_ITEMS as unknown as { value: string; label: string }[]}
          value={tab}
          onValueChange={(v) => setTab(v as TabKey)}
          id="return-warranty-tabs"
        />
      </div>

      {tab === 'expiring' && (
        <Card className="mb-4 flex flex-wrap items-center gap-3">
          <label htmlFor="expiring-days" className="text-sm">
            Window (days)
          </label>
          <NativeSelect
            id="expiring-days"
            value={String(expiringDays)}
            onChange={(e) => setExpiringDays(Number(e.target.value))}
          >
            {[3, 7, 14, 30].map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </NativeSelect>
        </Card>
      )}

      {err && (
        <Alert variant="error" className="mb-4">
          {err}
        </Alert>
      )}

      <TabPanel value="active" active={tab} tabsId="return-warranty-tabs">
        <ReturnTable
          rows={rows}
          loading={loading}
          emptyTitle="No active return windows."
          emptyDescription="Open a transaction and add a return deadline to track it here."
          onEdit={setEditing}
          showReturnDeadline
          showWarranty
        />
      </TabPanel>

      <TabPanel value="expiring" active={tab} tabsId="return-warranty-tabs">
        <ReturnTable
          rows={rows}
          loading={loading}
          emptyTitle={`Nothing expiring in the next ${expiringDays} days.`}
          emptyDescription="Widen the window or check back later."
          onEdit={setEditing}
          showReturnDeadline
          showWarranty={false}
          highlightExpiringSoon
        />
      </TabPanel>

      <TabPanel value="warranties" active={tab} tabsId="return-warranty-tabs">
        <ReturnTable
          rows={rows}
          loading={loading}
          emptyTitle="No warranty-covered purchases."
          emptyDescription="Add a warranty end date to a purchase to track it here."
          onEdit={setEditing}
          showReturnDeadline={false}
          showWarranty
        />
      </TabPanel>

      <TabPanel value="missing" active={tab} tabsId="return-warranty-tabs">
        <ReturnTable
          rows={rows}
          loading={loading}
          emptyTitle="No purchases are missing receipts."
          emptyDescription="Mark a purchase 'Missing' to flag it for follow-up."
          onEdit={setEditing}
          showReturnDeadline
          showWarranty
        />
      </TabPanel>

      {editing && (
        <EditDialog
          row={editing}
          onClose={() => setEditing(null)}
          onSave={(patch) => savePatch(editing.id, patch)}
        />
      )}
    </div>
  )
}

function ReturnTable({
  rows,
  loading,
  emptyTitle,
  emptyDescription,
  onEdit,
  showReturnDeadline,
  showWarranty,
  highlightExpiringSoon,
}: {
  rows: ReturnWarrantyRowView[]
  loading: boolean
  emptyTitle: string
  emptyDescription: string
  onEdit: (row: ReturnWarrantyRowView) => void
  showReturnDeadline: boolean
  showWarranty: boolean
  highlightExpiringSoon?: boolean
}) {
  return (
    <Card className="overflow-x-auto p-0">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Date</TableHead>
            <TableHead>Merchant</TableHead>
            <TableHead>Amount</TableHead>
            <TableHead>Receipt</TableHead>
            {showReturnDeadline && <TableHead>Return deadline</TableHead>}
            {showWarranty && <TableHead>Warranty ends</TableHead>}
            <TableHead aria-label="actions" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {loading ? (
            Array.from({ length: 4 }).map((_, i) => (
              <SkeletonRow key={`rw-skel-${i}`} cols={COLUMN_COUNT} />
            ))
          ) : rows.length === 0 ? (
            <EmptyTableRow
              colSpan={COLUMN_COUNT}
              title={emptyTitle}
              description={emptyDescription}
            />
          ) : (
            rows.map((row) => (
              <RowView
                key={row.id}
                row={row}
                onEdit={() => onEdit(row)}
                showReturnDeadline={showReturnDeadline}
                showWarranty={showWarranty}
                highlightExpiringSoon={highlightExpiringSoon}
              />
            ))
          )}
        </TableBody>
      </Table>
    </Card>
  )
}

function RowView({
  row,
  onEdit,
  showReturnDeadline,
  showWarranty,
  highlightExpiringSoon,
}: {
  row: ReturnWarrantyRowView
  onEdit: () => void
  showReturnDeadline: boolean
  showWarranty: boolean
  highlightExpiringSoon?: boolean
}) {
  const amountNum =
    row.amount === '' || row.amount == null ? null : Number(row.amount)
  return (
    <TableRow>
      <TableCell>{row.date}</TableCell>
      <TableCell>
        <div>{row.merchant}</div>
        {row.accountName && (
          <div className="text-xs text-muted-foreground">{row.accountName}</div>
        )}
      </TableCell>
      <TableCell>{formatMoneyOr(amountNum, row.currency)}</TableCell>
      <TableCell>
        <Badge variant={RECEIPT_STATUS_VARIANT[row.receiptStatus]}>
          {receiptStatusLabel(row.receiptStatus)}
        </Badge>
        {row.hasReceipt && row.receiptStatus !== 'have' && (
          <div className="text-xs text-muted-foreground mt-1">attachment on file</div>
        )}
      </TableCell>
      {showReturnDeadline && (
        <TableCell>
          {row.returnDeadline ? (
            <DeadlineCell
              date={row.returnDeadline}
              days={row.daysUntilReturnDeadline}
              icon={
                <CalendarClock className="inline-block size-3 align-text-bottom" />
              }
              expiringSoon={Boolean(highlightExpiringSoon)}
            />
          ) : (
            <span className="text-sm text-muted-foreground">—</span>
          )}
        </TableCell>
      )}
      {showWarranty && (
        <TableCell>
          {row.warrantyEndDate ? (
            <DeadlineCell
              date={row.warrantyEndDate}
              days={row.daysUntilWarrantyEnd}
              icon={
                <ShieldCheck className="inline-block size-3 align-text-bottom" />
              }
            />
          ) : (
            <span className="text-sm text-muted-foreground">—</span>
          )}
        </TableCell>
      )}
      <TableCell>
        <Button variant="outline" size="sm" onClick={onEdit}>
          Edit
        </Button>
      </TableCell>
    </TableRow>
  )
}

function DeadlineCell({
  date,
  days,
  icon,
  expiringSoon,
}: {
  date: string
  days: number | null
  icon: React.ReactNode
  expiringSoon?: boolean
}) {
  const expired = days != null && days < 0
  const soon = !expired && days != null && days <= 7
  // Tone classes are literal so Tailwind JIT keeps them.
  const tone = expired
    ? 'text-destructive'
    : soon || expiringSoon
      ? 'text-warning'
      : ''
  return (
    <div className={tone}>
      <div>
        {icon} {date}
      </div>
      <div className="text-xs">
        {days == null ? '' : expired ? `${Math.abs(days)}d ago` : `in ${days}d`}
        {expired && (
          <span className="ml-1 inline-flex items-center gap-1">
            <AlertTriangle className="inline-block size-3" /> expired
          </span>
        )}
      </div>
    </div>
  )
}

function receiptStatusLabel(s: ReceiptStatus): string {
  switch (s) {
    case 'have':
      return 'Have it'
    case 'missing':
      return 'Missing'
    case 'not_needed':
      return 'Not needed'
    case 'unknown':
    default:
      return 'Unknown'
  }
}

function EditDialog({
  row,
  onClose,
  onSave,
}: {
  row: ReturnWarrantyRowView
  onClose: () => void
  onSave: (patch: {
    returnDeadline?: string | null
    warrantyEndDate?: string | null
    receiptStatus?: ReceiptStatus
    notes?: string | null
  }) => void
}) {
  const [returnDeadline, setReturnDeadline] = useState<string>(
    row.returnDeadline ?? '',
  )
  const [warrantyEndDate, setWarrantyEndDate] = useState<string>(
    row.warrantyEndDate ?? '',
  )
  const [receiptStatus, setReceiptStatus] = useState<ReceiptStatus>(
    row.receiptStatus,
  )
  const [notes, setNotes] = useState<string>(row.notes ?? '')
  const [saving, setSaving] = useState(false)

  const initial = useMemo(
    () => ({
      returnDeadline: row.returnDeadline ?? '',
      warrantyEndDate: row.warrantyEndDate ?? '',
      receiptStatus: row.receiptStatus,
      notes: row.notes ?? '',
    }),
    [row],
  )

  function submit(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true)
    const patch: Record<string, unknown> = {}
    if (returnDeadline !== initial.returnDeadline) {
      patch.returnDeadline = returnDeadline === '' ? null : returnDeadline
    }
    if (warrantyEndDate !== initial.warrantyEndDate) {
      patch.warrantyEndDate = warrantyEndDate === '' ? null : warrantyEndDate
    }
    if (receiptStatus !== initial.receiptStatus) {
      patch.receiptStatus = receiptStatus
    }
    if (notes !== initial.notes) {
      patch.notes = notes === '' ? null : notes
    }
    onSave(patch)
    setSaving(false)
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Edit return and warranty for ${row.merchant}`}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <Card className="w-full max-w-md p-5">
        <h2 className="mb-3 text-lg font-semibold">Edit return / warranty</h2>
        <p className="text-sm text-muted-foreground mb-4">
          {row.merchant} · {row.date}
        </p>
        <form onSubmit={submit} className="flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-sm">
            <span>Return deadline</span>
            <Input
              type="date"
              value={returnDeadline}
              onChange={(e) => setReturnDeadline(e.target.value)}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span>Warranty end date</span>
            <Input
              type="date"
              value={warrantyEndDate}
              onChange={(e) => setWarrantyEndDate(e.target.value)}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span>Receipt status</span>
            <NativeSelect
              value={receiptStatus}
              onChange={(e) => setReceiptStatus(e.target.value as ReceiptStatus)}
            >
              {RECEIPT_STATUS_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </NativeSelect>
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span>Notes</span>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
              className="rounded-md border border-input bg-background/70 px-3 py-1 text-sm"
              maxLength={4000}
            />
          </label>
          <div className="mt-2 flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving}>
              {saving ? 'Saving…' : 'Save'}
            </Button>
          </div>
        </form>
      </Card>
    </div>
  )
}
