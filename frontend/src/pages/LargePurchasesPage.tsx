/**
 * Large purchase review workflow (issue #244). Surfaces transactions above
 * the configured threshold so users can work through a review checklist —
 * category, business relevance, receipt, warranty, and reimbursement tracking.
 *
 * Three tabs: inbox (pending), reviewed, dismissed. Each row has an inline
 * "Review" action that opens a checklist dialog backed by
 * PATCH /api/transactions/:id/large-purchase-review.
 *
 * Vanilla useState/useEffect fetch pattern (no TanStack Query), matching the
 * rest of the app.
 */
import { useCallback, useEffect, useState } from 'react'
import { CheckCircle2, XCircle } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { EmptyTableRow } from '@/components/ui/empty-state'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { PageHeader } from '@/components/ui/page-header'
import { SkeletonRow } from '@/components/ui/skeleton'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Tabs, TabPanel, type TabItem } from '@/components/ui/tabs'
import { useToast } from '@/components/ui/toast'
import { getJson, patchJson } from '../lib/api'
import { todayDateInputValue } from '../lib/dateInput'
import { formatMoney } from '../lib/formatMoney'
import type {
  LargePurchaseReviewStatus,
  LargePurchaseRowView,
  LargePurchaseListResponse,
  LargePurchaseReviewPatchResponse,
} from '../types/largePurchaseReview'

/** Tailwind variant lookup for status badges — literal class names for JIT. */
const STATUS_VARIANT: Record<
  LargePurchaseReviewStatus,
  'default' | 'secondary' | 'outline' | 'destructive'
> = {
  pending: 'outline',
  reviewed: 'default',
  dismissed: 'secondary',
}

const STATUS_LABEL: Record<LargePurchaseReviewStatus, string> = {
  pending: 'Pending',
  reviewed: 'Reviewed',
  dismissed: 'Dismissed',
}

type TabKey = 'inbox' | 'reviewed' | 'dismissed'

const TAB_ITEMS: TabItem[] = [
  { value: 'inbox', label: 'Inbox' },
  { value: 'reviewed', label: 'Reviewed' },
  { value: 'dismissed', label: 'Dismissed' },
]

const COLUMN_COUNT = 6

/** Checklist fields shown in the review dialog. */
interface ChecklistItem {
  field: keyof Pick<
    LargePurchaseRowView['review'],
    | 'categoryConfirmed'
    | 'businessRelevant'
    | 'receiptConfirmed'
    | 'warrantyTracked'
    | 'reimbursementTracked'
  >
  label: string
}

const CHECKLIST_ITEMS: ChecklistItem[] = [
  { field: 'categoryConfirmed', label: 'Category is correctly assigned' },
  { field: 'businessRelevant', label: 'Business relevance assessed' },
  { field: 'receiptConfirmed', label: 'Receipt on file or not needed' },
  { field: 'warrantyTracked', label: 'Warranty tracked (or not applicable)' },
  { field: 'reimbursementTracked', label: 'Reimbursement tracked (or not applicable)' },
]

/** Local dialog state for the review checklist. */
interface ReviewFormState {
  categoryConfirmed: boolean
  businessRelevant: boolean
  receiptConfirmed: boolean
  warrantyTracked: boolean
  reimbursementTracked: boolean
  notes: string
  status: LargePurchaseReviewStatus
}

function reviewFormFromRow(row: LargePurchaseRowView): ReviewFormState {
  const r = row.review
  return {
    categoryConfirmed: r.categoryConfirmed ?? false,
    businessRelevant: r.businessRelevant ?? false,
    receiptConfirmed: r.receiptConfirmed ?? false,
    warrantyTracked: r.warrantyTracked ?? false,
    reimbursementTracked: r.reimbursementTracked ?? false,
    notes: r.notes ?? '',
    status: r.status,
  }
}

export function LargePurchasesPage() {
  const { showToast } = useToast()
  const [tab, setTab] = useState<TabKey>('inbox')
  const [rows, setRows] = useState<LargePurchaseRowView[]>([])
  const [threshold, setThreshold] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [reviewing, setReviewing] = useState<LargePurchaseRowView | null>(null)
  const [form, setForm] = useState<ReviewFormState | null>(null)
  const [saving, setSaving] = useState(false)

  const endpointForTab = useCallback((which: TabKey): string => {
    switch (which) {
      case 'inbox':
        return '/api/large-purchases/inbox'
      case 'reviewed':
      case 'dismissed':
        // All endpoint, then we filter in the response to show only the right status.
        return '/api/large-purchases/all'
    }
  }, [])

  const refresh = useCallback(async () => {
    setLoading(true)
    setErr(null)
    try {
      const res = await getJson<LargePurchaseListResponse>(endpointForTab(tab))
      setThreshold(res.threshold)
      // For inbox tab the API already filters; for reviewed/dismissed we filter here.
      if (tab === 'reviewed') {
        setRows(res.data.filter((r) => r.review.status === 'reviewed'))
      } else if (tab === 'dismissed') {
        setRows(res.data.filter((r) => r.review.status === 'dismissed'))
      } else {
        setRows(res.data)
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed to load')
    } finally {
      setLoading(false)
    }
  }, [tab, endpointForTab])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const openReview = useCallback((row: LargePurchaseRowView) => {
    setReviewing(row)
    setForm(reviewFormFromRow(row))
  }, [])

  const closeReview = useCallback(() => {
    setReviewing(null)
    setForm(null)
  }, [])

  const saveReview = useCallback(
    async (finalStatus: LargePurchaseReviewStatus, currentForm: ReviewFormState) => {
      if (!reviewing) return
      setSaving(true)
      try {
        const today = todayDateInputValue()
        const res = await patchJson<LargePurchaseReviewPatchResponse>(
          `/api/transactions/${reviewing.id}/large-purchase-review`,
          {
            status: finalStatus,
            categoryConfirmed: currentForm.categoryConfirmed,
            businessRelevant: currentForm.businessRelevant,
            receiptConfirmed: currentForm.receiptConfirmed,
            warrantyTracked: currentForm.warrantyTracked,
            reimbursementTracked: currentForm.reimbursementTracked,
            notes: currentForm.notes || null,
            reviewedAt: finalStatus === 'reviewed' ? today : null,
          },
        )
        showToast({
          title:
            res.data.status === 'reviewed'
              ? 'Marked as reviewed'
              : 'Review saved',
          variant: 'success',
        })
        closeReview()
        void refresh()
      } catch (e) {
        showToast({
          title: 'Failed to save',
          description: e instanceof Error ? e.message : undefined,
          variant: 'destructive',
        })
      } finally {
        setSaving(false)
      }
    },
    [reviewing, closeReview, refresh, showToast],
  )

  return (
    <>
      <PageHeader
        title="Large purchases"
        description={
          threshold !== null
            ? `Showing transactions ≥ ${formatMoney(Number(threshold), 'CAD')} for review`
            : 'Review your large purchases'
        }
      />

      <Card>
        <Tabs
          value={tab}
          onValueChange={(v) => setTab(v as TabKey)}
          items={TAB_ITEMS}
        />

        <TabPanel value="inbox" active={tab}>
          <PurchaseTable
            rows={rows}
            loading={loading}
            err={err}
            onReview={openReview}
          />
        </TabPanel>

        <TabPanel value="reviewed" active={tab}>
          <PurchaseTable
            rows={rows}
            loading={loading}
            err={err}
            onReview={openReview}
          />
        </TabPanel>

        <TabPanel value="dismissed" active={tab}>
          <PurchaseTable
            rows={rows}
            loading={loading}
            err={err}
            onReview={openReview}
          />
        </TabPanel>
      </Card>

      {reviewing && form && (
        <ReviewDialog
          row={reviewing}
          form={form}
          saving={saving}
          onChange={setForm}
          onSave={(status) => void saveReview(status, form)}
          onClose={closeReview}
        />
      )}
    </>
  )
}

// ---------- PurchaseTable component ------------------------------------------

interface PurchaseTableProps {
  rows: LargePurchaseRowView[]
  loading: boolean
  err: string | null
  onReview: (row: LargePurchaseRowView) => void
}

function PurchaseTable({ rows, loading, err, onReview }: PurchaseTableProps) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Date</TableHead>
          <TableHead>Merchant</TableHead>
          <TableHead>Category</TableHead>
          <TableHead>Account</TableHead>
          <TableHead className="text-right">Amount</TableHead>
          <TableHead>Status</TableHead>
          <TableHead />
        </TableRow>
      </TableHeader>
      <TableBody>
        {loading && <SkeletonRow cols={COLUMN_COUNT + 1} />}
        {!loading && err && (
          <TableRow>
            <TableCell colSpan={COLUMN_COUNT + 1} className="text-destructive">
              {err}
            </TableCell>
          </TableRow>
        )}
        {!loading && !err && rows.length === 0 && (
          <EmptyTableRow
            colSpan={COLUMN_COUNT + 1}
            title="No purchases in this section"
          />
        )}
        {!loading &&
          !err &&
          rows.map((row) => (
            <TableRow key={row.id}>
              <TableCell className="whitespace-nowrap">{row.date}</TableCell>
              <TableCell>{row.merchant}</TableCell>
              <TableCell className="text-muted-foreground">
                {row.finalCategory ?? '—'}
              </TableCell>
              <TableCell className="text-muted-foreground">
                {row.accountName ?? '—'}
              </TableCell>
              <TableCell className="text-right font-mono">
                {formatMoney(Number(row.amount), row.currency)}
              </TableCell>
              <TableCell>
                <Badge variant={STATUS_VARIANT[row.review.status]}>
                  {STATUS_LABEL[row.review.status]}
                </Badge>
              </TableCell>
              <TableCell>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => onReview(row)}
                >
                  {row.review.status === 'pending' ? 'Review' : 'Edit'}
                </Button>
              </TableCell>
            </TableRow>
          ))}
      </TableBody>
    </Table>
  )
}

// ---------- ReviewDialog component -------------------------------------------

interface ReviewDialogProps {
  row: LargePurchaseRowView
  form: ReviewFormState
  saving: boolean
  onChange: (form: ReviewFormState) => void
  onSave: (status: LargePurchaseReviewStatus) => void
  onClose: () => void
}

function ReviewDialog({
  row,
  form,
  saving,
  onChange,
  onSave,
  onClose,
}: ReviewDialogProps) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-background border rounded-lg shadow-xl w-full max-w-lg p-6 space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="font-semibold text-lg">{row.merchant}</h2>
            <p className="text-sm text-muted-foreground">
              {row.date} &bull; {formatMoney(Number(row.amount), row.currency)}
            </p>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={onClose}
            aria-label="Close"
          >
            <XCircle className="h-5 w-5" />
          </Button>
        </div>

        <div className="space-y-2">
          {CHECKLIST_ITEMS.map(({ field, label }) => (
            <div key={field} className="flex items-center gap-2">
              <input
                id={`check-${field}`}
                type="checkbox"
                className="h-4 w-4 cursor-pointer accent-primary"
                checked={form[field] as boolean}
                onChange={(e) =>
                  onChange({ ...form, [field]: e.target.checked })
                }
              />
              <Label htmlFor={`check-${field}`} className="cursor-pointer font-normal">
                {label}
              </Label>
            </div>
          ))}
        </div>

        <div className="space-y-1">
          <Label htmlFor="review-notes">Notes</Label>
          <Input
            id="review-notes"
            value={form.notes}
            onChange={(e) => onChange({ ...form, notes: e.target.value })}
            placeholder="Optional notes about this purchase..."
          />
        </div>

        <div className="flex gap-2 pt-2">
          <Button
            className="flex-1"
            onClick={() => onSave('reviewed')}
            disabled={saving}
          >
            <CheckCircle2 className="h-4 w-4 mr-1" />
            Mark reviewed
          </Button>
          <Button
            variant="outline"
            onClick={() => onSave('dismissed')}
            disabled={saving}
          >
            Dismiss
          </Button>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
        </div>
      </div>
    </div>
  )
}
