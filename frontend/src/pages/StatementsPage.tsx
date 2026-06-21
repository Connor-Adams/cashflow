import { useCallback, useEffect, useMemo, useState } from 'react'
import { Badge, Icon } from '@connor-adams/designsystem'
import { Button } from '@connor-adams/designsystem'
import { CollapsibleCard } from '@/components/ui/collapsible-card'
import { EmptyTableRow } from '@/lib/ds-extras'
import { PageHeader } from '@/components/ui/page-header'
import { SkeletonRow } from '@/lib/ds-extras'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@connor-adams/designsystem'
import { useToast } from '@/components/ui/toast'
import { deleteReq, getJson, patchJson, postJson } from '../lib/api'
import { formatMoney } from '../lib/formatMoney'
import type {
  Account,
  AccountStatement,
  StatementDetailResponse,
  StatementListResponse,
} from '../types/api'

/**
 * Issue #242 — Statement reconciliation surface.
 *
 * Three panels:
 *   1. Create form: pick account, date range, opening + closing balance.
 *   2. List: all statements with status badges + click to inspect.
 *   3. Detail: expected closing vs reported closing with variance,
 *      reconcile/unreconcile actions, in-period transactions table.
 *
 * The page sticks to plain Tailwind utilities + existing ui/* primitives
 * to match the Cashflow design system (no new global CSS).
 */

const STATEMENT_COLUMN_COUNT = 7

type AccountSummary = Pick<
  Account,
  'id' | 'name' | 'shortCode' | 'defaultCurrency' | 'accountType' | 'closedAt'
>

function formatDate(value: string | null | undefined): string {
  if (!value) return ''
  // YYYY-MM-DD is already ISO; render as-is for now to keep the UI
  // timezone-stable. The shared formatMoney helper handles currency below.
  return value.slice(0, 10)
}

function statusLabel(s: AccountStatement): string {
  return s.reconciledAt ? 'Reconciled' : 'Unreconciled'
}

function StatementStatusBadge({ row }: { row: AccountStatement }) {
  return row.reconciledAt ? (
    <Badge variant="secondary">Reconciled</Badge>
  ) : (
    <Badge variant="outline">Unreconciled</Badge>
  )
}

export function StatementsPage() {
  const { showToast } = useToast()
  const [accounts, setAccounts] = useState<AccountSummary[]>([])
  const [list, setList] = useState<StatementListResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [detail, setDetail] = useState<StatementDetailResponse | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [filterAccountId, setFilterAccountId] = useState<string>('')

  // Create form state.
  const [formAccountId, setFormAccountId] = useState<string>('')
  const [formPeriodStart, setFormPeriodStart] = useState<string>('')
  const [formPeriodEnd, setFormPeriodEnd] = useState<string>('')
  const [formOpening, setFormOpening] = useState<string>('')
  const [formClosing, setFormClosing] = useState<string>('')
  const [formSource, setFormSource] = useState<string>('')
  const [formNotes, setFormNotes] = useState<string>('')
  const [submitting, setSubmitting] = useState(false)

  const refreshList = useCallback(async () => {
    setLoading(true)
    setErr(null)
    try {
      const qs = filterAccountId
        ? `?accountId=${encodeURIComponent(filterAccountId)}&pageSize=100`
        : '?pageSize=100'
      const l = await getJson<StatementListResponse>(`/api/accounts/statements${qs}`)
      setList(l)
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Error')
    } finally {
      setLoading(false)
    }
  }, [filterAccountId])

  // Accounts only need to be loaded once — they rarely change during a session.
  useEffect(() => {
    void (async () => {
      try {
        const a = await getJson<AccountSummary[]>('/api/accounts')
        setAccounts(a)
      } catch (e) {
        setErr(e instanceof Error ? e.message : 'Error')
      }
    })()
  }, [])

  useEffect(() => {
    void refreshList()
  }, [refreshList])

  const loadDetail = useCallback(async (id: number) => {
    setDetailLoading(true)
    try {
      const d = await getJson<StatementDetailResponse>(`/api/accounts/statements/${id}`)
      setDetail(d)
      setSelectedId(id)
    } catch (e) {
      showToast({
        title: e instanceof Error ? e.message : 'Error loading detail',
        variant: 'destructive',
      })
    } finally {
      setDetailLoading(false)
    }
  }, [showToast])

  const onCreate = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault()
      const accountId = Number.parseInt(formAccountId, 10)
      if (!Number.isInteger(accountId) || accountId <= 0) {
        showToast({ title: 'Pick an account', variant: 'destructive' })
        return
      }
      if (!formPeriodStart || !formPeriodEnd) {
        showToast({ title: 'Period dates required', variant: 'destructive' })
        return
      }
      const opening = Number.parseFloat(formOpening)
      const closing = Number.parseFloat(formClosing)
      if (!Number.isFinite(opening) || !Number.isFinite(closing)) {
        showToast({
          title: 'Opening and closing balance are required',
          variant: 'destructive',
        })
        return
      }
      setSubmitting(true)
      try {
        const created = await postJson<{ data: AccountStatement }>(
          '/api/accounts/statements',
          {
            accountId,
            periodStart: formPeriodStart,
            periodEnd: formPeriodEnd,
            openingBalance: opening,
            closingBalance: closing,
            sourceFilename: formSource || undefined,
            notes: formNotes || undefined,
          },
        )
        showToast({ title: 'Statement created', variant: 'success' })
        setFormAccountId('')
        setFormPeriodStart('')
        setFormPeriodEnd('')
        setFormOpening('')
        setFormClosing('')
        setFormSource('')
        setFormNotes('')
        await refreshList()
        await loadDetail(created.data.id)
      } catch (e) {
        showToast({
          title: e instanceof Error ? e.message : 'Create failed',
          variant: 'destructive',
        })
      } finally {
        setSubmitting(false)
      }
    },
    [
      formAccountId,
      formPeriodStart,
      formPeriodEnd,
      formOpening,
      formClosing,
      formSource,
      formNotes,
      loadDetail,
      refreshList,
      showToast,
    ],
  )

  const onReconcile = useCallback(
    async (id: number, explanation?: string) => {
      try {
        const d = await postJson<StatementDetailResponse>(
          `/api/accounts/statements/${id}/reconcile`,
          explanation != null ? { varianceExplanation: explanation } : {},
        )
        setDetail(d)
        showToast({ title: 'Statement reconciled', variant: 'success' })
        await refreshList()
      } catch (e) {
        showToast({
          title: e instanceof Error ? e.message : 'Reconcile failed',
          variant: 'destructive',
        })
      }
    },
    [refreshList, showToast],
  )

  const onUnreconcile = useCallback(
    async (id: number) => {
      try {
        const d = await postJson<StatementDetailResponse>(
          `/api/accounts/statements/${id}/unreconcile`,
        )
        setDetail(d)
        showToast({ title: 'Reconciliation cleared', variant: 'success' })
        await refreshList()
      } catch (e) {
        showToast({
          title: e instanceof Error ? e.message : 'Unreconcile failed',
          variant: 'destructive',
        })
      }
    },
    [refreshList, showToast],
  )

  const onSaveExplanation = useCallback(
    async (id: number, explanation: string) => {
      try {
        const d = await patchJson<StatementDetailResponse>(
          `/api/accounts/statements/${id}`,
          { varianceExplanation: explanation },
        )
        setDetail(d)
        showToast({ title: 'Explanation saved', variant: 'success' })
      } catch (e) {
        showToast({
          title: e instanceof Error ? e.message : 'Save failed',
          variant: 'destructive',
        })
      }
    },
    [showToast],
  )

  const onDelete = useCallback(
    async (id: number) => {
      if (!window.confirm('Delete this statement? This cannot be undone.')) return
      try {
        await deleteReq(`/api/accounts/statements/${id}`)
        setDetail(null)
        setSelectedId(null)
        showToast({ title: 'Statement deleted', variant: 'success' })
        await refreshList()
      } catch (e) {
        showToast({
          title: e instanceof Error ? e.message : 'Delete failed',
          variant: 'destructive',
        })
      }
    },
    [refreshList, showToast],
  )

  const accountById = useMemo(() => {
    const m = new Map<number, AccountSummary>()
    for (const a of accounts) m.set(a.id, a)
    return m
  }, [accounts])

  const visibleAccounts = useMemo(
    () => accounts.filter((a) => !a.closedAt),
    [accounts],
  )

  return (
    <main className="page-stack">
      <PageHeader
        title="Statement reconciliation"
        description="Compare imported or manually-entered statements against your transactions. Variance highlights catch missed or duplicate imports before they corrupt your reports."
        actions={
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => void refreshList()}
            aria-label="Refresh statements"
          >
            <Icon name="refresh-cw" aria-hidden="true" />
            Refresh
          </Button>
        }
      />

      <CollapsibleCard
        title="Add a statement"
        description="Record the opening and closing balance from a statement to check against your ledger."
        defaultOpen={(list?.data.length ?? 0) === 0}
      >
        <form className="space-y-3" onSubmit={onCreate}>
          <div className="grid gap-3 md:grid-cols-2">
            <label className="block text-sm">
              <span className="block text-muted-foreground">Account</span>
              <select
                className="mt-1 w-full rounded border border-input bg-background px-2 py-1.5"
                value={formAccountId}
                onChange={(e) => setFormAccountId(e.target.value)}
              >
                <option value="">Select…</option>
                {visibleAccounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                    {a.shortCode ? ` (${a.shortCode})` : ''}
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-sm">
              <span className="block text-muted-foreground">Source filename (optional)</span>
              <input
                type="text"
                className="mt-1 w-full rounded border border-input bg-background px-2 py-1.5"
                value={formSource}
                onChange={(e) => setFormSource(e.target.value)}
                placeholder="jan-2026-cibc.pdf"
              />
            </label>
            <label className="block text-sm">
              <span className="block text-muted-foreground">Period start</span>
              <input
                type="date"
                className="mt-1 w-full rounded border border-input bg-background px-2 py-1.5"
                value={formPeriodStart}
                onChange={(e) => setFormPeriodStart(e.target.value)}
              />
            </label>
            <label className="block text-sm">
              <span className="block text-muted-foreground">Period end</span>
              <input
                type="date"
                className="mt-1 w-full rounded border border-input bg-background px-2 py-1.5"
                value={formPeriodEnd}
                onChange={(e) => setFormPeriodEnd(e.target.value)}
              />
            </label>
            <label className="block text-sm">
              <span className="block text-muted-foreground">Opening balance</span>
              <input
                type="number"
                step="0.01"
                className="mt-1 w-full rounded border border-input bg-background px-2 py-1.5 font-mono"
                value={formOpening}
                onChange={(e) => setFormOpening(e.target.value)}
              />
            </label>
            <label className="block text-sm">
              <span className="block text-muted-foreground">Closing balance</span>
              <input
                type="number"
                step="0.01"
                className="mt-1 w-full rounded border border-input bg-background px-2 py-1.5 font-mono"
                value={formClosing}
                onChange={(e) => setFormClosing(e.target.value)}
              />
            </label>
          </div>
          <label className="block text-sm">
            <span className="block text-muted-foreground">Notes (optional)</span>
            <textarea
              rows={2}
              className="mt-1 w-full rounded border border-input bg-background px-2 py-1.5"
              value={formNotes}
              onChange={(e) => setFormNotes(e.target.value)}
            />
          </label>
          <Button type="submit" size="sm" disabled={submitting}>
            <Icon name="plus" aria-hidden="true" />
            {submitting ? 'Saving…' : 'Create statement'}
          </Button>
        </form>
      </CollapsibleCard>

      <CollapsibleCard
        title="Statements"
        description="One row per imported or manually-entered statement period."
        defaultOpen
      >
        <div className="mb-2 flex items-center gap-2 text-sm">
          <span className="text-muted-foreground">Filter:</span>
          <select
            className="rounded border border-input bg-background px-2 py-1"
            value={filterAccountId}
            onChange={(e) => setFilterAccountId(e.target.value)}
            aria-label="Filter statements by account"
          >
            <option value="">All accounts</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </div>
        {err && <p className="text-sm text-destructive">{err}</p>}
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Period</TableHead>
              <TableHead>Account</TableHead>
              <TableHead className="text-right">Opening</TableHead>
              <TableHead className="text-right">Closing</TableHead>
              <TableHead>Currency</TableHead>
              <TableHead>Status</TableHead>
              <TableHead></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              <SkeletonRow cols={STATEMENT_COLUMN_COUNT} />
            ) : list?.data.length === 0 ? (
              <EmptyTableRow
                colSpan={STATEMENT_COLUMN_COUNT}
                title="No statements yet"
                description="Add a statement above to start reconciling."
              />
            ) : (
              list?.data.map((row) => {
                const a = row.account ?? accountById.get(row.accountId)
                return (
                  <TableRow
                    key={row.id}
                    data-state={selectedId === row.id ? 'selected' : undefined}
                  >
                    <TableCell className="font-mono text-xs">
                      {formatDate(row.periodStart)} → {formatDate(row.periodEnd)}
                    </TableCell>
                    <TableCell>
                      {a?.name ?? `Account #${row.accountId}`}
                    </TableCell>
                    <TableCell className="text-right font-mono">
                      {formatMoney(row.openingBalance, row.currency)}
                    </TableCell>
                    <TableCell className="text-right font-mono">
                      {formatMoney(row.closingBalance, row.currency)}
                    </TableCell>
                    <TableCell>{row.currency}</TableCell>
                    <TableCell>
                      <StatementStatusBadge row={row} />
                    </TableCell>
                    <TableCell>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() => void loadDetail(row.id)}
                      >
                        Inspect
                      </Button>
                    </TableCell>
                  </TableRow>
                )
              })
            )}
          </TableBody>
        </Table>
      </CollapsibleCard>

      {selectedId != null && (
        <StatementDetailPanel
          loading={detailLoading}
          detail={detail}
          onReconcile={(explanation) => onReconcile(selectedId, explanation)}
          onUnreconcile={() => onUnreconcile(selectedId)}
          onSaveExplanation={(explanation) =>
            onSaveExplanation(selectedId, explanation)
          }
          onDelete={() => onDelete(selectedId)}
          onClose={() => {
            setSelectedId(null)
            setDetail(null)
          }}
        />
      )}
    </main>
  )
}

function StatementDetailPanel({
  detail,
  loading,
  onReconcile,
  onUnreconcile,
  onSaveExplanation,
  onDelete,
  onClose,
}: {
  detail: StatementDetailResponse | null
  loading: boolean
  onReconcile: (explanation?: string) => void
  onUnreconcile: () => void
  onSaveExplanation: (explanation: string) => void
  onDelete: () => void
  onClose: () => void
}) {
  const [explanation, setExplanation] = useState<string>('')

  useEffect(() => {
    setExplanation(detail?.data.varianceExplanation ?? '')
  }, [detail?.data.id, detail?.data.varianceExplanation])

  if (loading || !detail) {
    return (
      <CollapsibleCard title="Loading…" defaultOpen>
        <p className="text-sm text-muted-foreground">Loading statement…</p>
      </CollapsibleCard>
    )
  }

  const { data, reconciliation, transactions } = detail
  const variance = reconciliation.variance
  const varianceColorClass =
    Math.abs(variance) <= 0.01
      ? 'text-positive'
      : 'text-warning'

  return (
    <CollapsibleCard
      title={`Statement #${data.id} — ${formatDate(data.periodStart)} → ${formatDate(data.periodEnd)}`}
      description={data.account?.name ?? `Account #${data.accountId}`}
      defaultOpen
      actions={
        <Button type="button" size="sm" variant="ghost" onClick={onClose}>
          Close
        </Button>
      }
    >
      <div className="grid gap-4 md:grid-cols-3">
        <div className="rounded border border-border p-3">
          <div className="text-xs text-muted-foreground">Reported closing</div>
          <div className="font-mono text-xl">
            {formatMoney(data.closingBalance, data.currency)}
          </div>
        </div>
        <div className="rounded border border-border p-3">
          <div className="text-xs text-muted-foreground">Expected closing</div>
          <div className="font-mono text-xl">
            {formatMoney(reconciliation.expectedClosing, data.currency)}
          </div>
        </div>
        <div className="rounded border border-border p-3">
          <div className="text-xs text-muted-foreground">Variance</div>
          <div className={`font-mono text-xl ${varianceColorClass}`}>
            {formatMoney(variance, data.currency)}
          </div>
          <div className="text-xs text-muted-foreground">
            {reconciliation.isBalanced
              ? 'Balanced'
              : 'Investigate — variance is non-zero'}
          </div>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <span className="text-sm text-muted-foreground">Status:</span>
        <StatementStatusBadge row={data} />
        {data.reconciledAt ? (
          <Button
            type="button"
            size="sm"
            variant="secondary"
            onClick={onUnreconcile}
          >
            Unreconcile
          </Button>
        ) : (
          <Button
            type="button"
            size="sm"
            onClick={() => onReconcile(explanation || undefined)}
          >
            Mark reconciled
          </Button>
        )}
        <Button type="button" size="sm" variant="destructive" onClick={onDelete}>
          Delete
        </Button>
      </div>

      <div className="mt-4 space-y-2">
        <label className="block text-sm">
          <span className="block text-muted-foreground">
            Variance explanation
            {!reconciliation.isBalanced ? ' (required to reconcile)' : ''}
          </span>
          <textarea
            rows={2}
            className="mt-1 w-full rounded border border-input bg-background px-2 py-1.5"
            value={explanation}
            onChange={(e) => setExplanation(e.target.value)}
            placeholder="e.g. Cash withdrawal not captured in CSV import"
          />
        </label>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={() => onSaveExplanation(explanation)}
        >
          Save explanation
        </Button>
      </div>

      <div className="mt-6">
        <h3 className="mb-2 text-sm font-semibold">
          Transactions in period ({reconciliation.transactionCount})
        </h3>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Date</TableHead>
              <TableHead>Merchant</TableHead>
              <TableHead>Category</TableHead>
              <TableHead className="text-right">Amount</TableHead>
              <TableHead>Type</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {transactions.length === 0 ? (
              <EmptyTableRow
                colSpan={5}
                title="No transactions in this period"
                description="Statements covering an empty window show only the opening = closing identity."
              />
            ) : (
              transactions.map((t) => (
                <TableRow key={t.id}>
                  <TableCell className="font-mono text-xs">{t.date}</TableCell>
                  <TableCell>{t.merchantClean || t.merchantRaw}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {t.finalCategory ?? '—'}
                  </TableCell>
                  <TableCell className="text-right font-mono">
                    {formatMoney(t.amount, t.currency)}
                  </TableCell>
                  <TableCell className="text-xs">
                    {t.txnType}
                    {t.linkedTransactionId ? ' · linked' : ''}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      <p className="mt-3 text-xs text-muted-foreground">
        Looking at status «{statusLabel(data)}». Variance comparison is per
        account — internal transfers and refunds contribute exactly once
        because each leg is a separate row on its own account.
      </p>
    </CollapsibleCard>
  )
}
