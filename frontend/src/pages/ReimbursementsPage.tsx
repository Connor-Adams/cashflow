/**
 * Reimbursement tracker dashboard (issue #216). Turns reimbursable
 * transactions into an actionable queue: an outstanding-by-party summary, an
 * overdue queue, and a filterable list. Per-row actions mark a claim
 * received/waived, or open a repayment-matching dialog that links the incoming
 * credit transaction.
 *
 * Intentionally simple: tabs + one table + a summary card + two small dialogs.
 * Vanilla useState/useEffect fetch (no TanStack Query), matching the rest of
 * the app.
 */
import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, CheckCircle2, Clock, Link2 } from 'lucide-react'
import { Link } from 'react-router-dom'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { EmptyTableRow } from '@/components/ui/empty-state'
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
import { Tabs, TabPanel } from '@/components/ui/tabs'
import { useToast } from '@/components/ui/toast'
import { getJson, postJson, patchJson } from '../lib/api'
import { formatMoney } from '../lib/formatMoney'
import type { Contact } from '@cashflow/shared'
import type {
  ReimbursementStatus,
  ReimbursementView,
  ReimbursementListResponse,
  ReimbursementItemResponse,
  ReimbursementSummaryResponse,
  RepaymentCandidate,
  RepaymentCandidatesResponse,
} from '../types/reimbursement'

/** Tailwind variant lookup for status badges — literal class names so the JIT
 *  compiler keeps them. */
const STATUS_VARIANT: Record<
  ReimbursementStatus,
  'default' | 'secondary' | 'outline' | 'destructive'
> = {
  expected: 'outline',
  received: 'default',
  overdue: 'destructive',
  waived: 'secondary',
}

const STATUS_LABEL: Record<ReimbursementStatus, string> = {
  expected: 'Expected',
  received: 'Received',
  overdue: 'Overdue',
  waived: 'Waived',
}

type TabKey = 'outstanding' | 'overdue' | 'received' | 'all'

const TAB_ITEMS = [
  { value: 'outstanding', label: 'Outstanding' },
  { value: 'overdue', label: 'Overdue' },
  { value: 'received', label: 'Received' },
  { value: 'all', label: 'All' },
] as const

const COLUMN_COUNT = 6

export function ReimbursementsPage() {
  const { showToast } = useToast()
  const [tab, setTab] = useState<TabKey>('outstanding')
  const [rows, setRows] = useState<ReimbursementView[]>([])
  const [summary, setSummary] = useState<ReimbursementSummaryResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [matching, setMatching] = useState<ReimbursementView | null>(null)

  const endpointForTab = useCallback((which: TabKey): string => {
    switch (which) {
      case 'outstanding':
        // Open claims (expected) — the derived-overdue ones surface here too.
        return '/api/reimbursements?status=expected'
      case 'overdue':
        return '/api/reimbursements/overdue'
      case 'received':
        return '/api/reimbursements?status=received'
      case 'all':
        return '/api/reimbursements'
    }
  }, [])

  const refresh = useCallback(async () => {
    setLoading(true)
    setErr(null)
    try {
      const [list, sum] = await Promise.all([
        getJson<ReimbursementListResponse>(endpointForTab(tab)),
        getJson<ReimbursementSummaryResponse>('/api/reimbursements/summary'),
      ])
      setRows(list.data)
      setSummary(sum)
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed to load')
    } finally {
      setLoading(false)
    }
  }, [endpointForTab, tab])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const setStatus = useCallback(
    async (row: ReimbursementView, status: ReimbursementStatus) => {
      try {
        await patchJson<ReimbursementItemResponse>(
          `/api/reimbursements/${row.id}`,
          { status },
        )
        showToast({ title: `Marked ${STATUS_LABEL[status].toLowerCase()}`, variant: 'success' })
        await refresh()
      } catch (e) {
        showToast({
          title: e instanceof Error ? e.message : 'Update failed',
          variant: 'destructive',
        })
      }
    },
    [refresh, showToast],
  )

  const unlink = useCallback(
    async (row: ReimbursementView) => {
      try {
        await postJson<ReimbursementItemResponse>(
          `/api/reimbursements/${row.id}/unlink-repayment`,
        )
        showToast({ title: 'Repayment unlinked', variant: 'success' })
        await refresh()
      } catch (e) {
        showToast({
          title: e instanceof Error ? e.message : 'Unlink failed',
          variant: 'destructive',
        })
      }
    },
    [refresh, showToast],
  )

  return (
    <div className="page">
      <PageHeader
        title="Reimbursements"
        description="Track money you're owed back — by partners, employers, insurers, or friends — and clear it when the repayment lands."
      />

      <SummaryCard summary={summary} />

      <div className="mb-4">
        <Tabs
          items={TAB_ITEMS as unknown as { value: string; label: string }[]}
          value={tab}
          onValueChange={(v) => setTab(v as TabKey)}
          id="reimbursements-tabs"
        />
      </div>

      {err && (
        <p className="error" role="alert">
          {err}
        </p>
      )}

      {(['outstanding', 'overdue', 'received', 'all'] as const).map((key) => (
        <TabPanel
          key={key}
          value={key}
          active={tab}
          tabsId="reimbursements-tabs"
        >
          <ReimbursementTable
            rows={rows}
            loading={loading}
            emptyTitle={emptyTitleFor(key)}
            onSetStatus={setStatus}
            onMatch={setMatching}
            onUnlink={unlink}
          />
        </TabPanel>
      ))}

      {matching && (
        <MatchDialog
          row={matching}
          onClose={() => setMatching(null)}
          onLinked={async () => {
            setMatching(null)
            await refresh()
          }}
        />
      )}
    </div>
  )
}

function emptyTitleFor(key: TabKey): string {
  switch (key) {
    case 'outstanding':
      return 'Nothing outstanding — you’re all caught up.'
    case 'overdue':
      return 'No overdue reimbursements.'
    case 'received':
      return 'No received reimbursements yet.'
    case 'all':
      return 'No reimbursements tracked yet.'
  }
}

function SummaryCard({ summary }: { summary: ReimbursementSummaryResponse | null }) {
  if (!summary) return null
  const currencies = Object.keys(summary.outstandingByCurrency)
  return (
    <Card className="mb-4 p-4">
      <div className="flex flex-wrap items-center gap-6">
        <div>
          <div className="muted text-xs uppercase tracking-wide">Outstanding</div>
          {currencies.length === 0 ? (
            <div className="text-lg font-semibold">—</div>
          ) : (
            <div className="flex flex-wrap gap-3">
              {currencies.map((cur) => (
                <span key={cur} className="text-lg font-semibold">
                  {formatMoney(Number(summary.outstandingByCurrency[cur]) || 0, cur)}
                </span>
              ))}
            </div>
          )}
        </div>
        <div>
          <div className="muted text-xs uppercase tracking-wide">Overdue</div>
          <div
            className={
              summary.overdueCount > 0
                ? 'text-lg font-semibold text-destructive'
                : 'text-lg font-semibold'
            }
          >
            {summary.overdueCount}
          </div>
        </div>
        <div>
          <div className="muted text-xs uppercase tracking-wide">Total claims</div>
          <div className="text-lg font-semibold">{summary.totalCount}</div>
        </div>
      </div>

      {summary.groups.length > 0 && (
        <div className="mt-4">
          <div className="muted mb-2 text-xs uppercase tracking-wide">
            Outstanding by party
          </div>
          <div className="flex flex-col gap-1">
            {summary.groups
              .filter((g) => Number(g.outstanding) > 0)
              .map((g) => (
                <div
                  key={g.key}
                  className="flex items-center justify-between text-sm"
                >
                  <span>
                    {g.partyLabel}
                    {g.counts.overdue > 0 && (
                      <Badge variant="destructive" className="ml-2">
                        {g.counts.overdue} overdue
                      </Badge>
                    )}
                  </span>
                  <span className="font-medium">
                    {formatMoney(Number(g.outstanding) || 0, g.currency)}
                  </span>
                </div>
              ))}
          </div>
        </div>
      )}
    </Card>
  )
}

function ReimbursementTable({
  rows,
  loading,
  emptyTitle,
  onSetStatus,
  onMatch,
  onUnlink,
}: {
  rows: ReimbursementView[]
  loading: boolean
  emptyTitle: string
  onSetStatus: (row: ReimbursementView, status: ReimbursementStatus) => void
  onMatch: (row: ReimbursementView) => void
  onUnlink: (row: ReimbursementView) => void
}) {
  return (
    <Card className="overflow-x-auto p-0">
      <Table className="table">
        <TableHeader>
          <TableRow>
            <TableHead>Party</TableHead>
            <TableHead>Amount</TableHead>
            <TableHead>Due</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Source</TableHead>
            <TableHead aria-label="actions" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {loading ? (
            Array.from({ length: 4 }).map((_, i) => (
              <SkeletonRow key={`reimb-skel-${i}`} cols={COLUMN_COUNT} />
            ))
          ) : rows.length === 0 ? (
            <EmptyTableRow
              colSpan={COLUMN_COUNT}
              title={emptyTitle}
              description="Open a transaction and choose ‘Mark reimbursable’ to start tracking."
            />
          ) : (
            rows.map((row) => (
              <ReimbursementRow
                key={row.id}
                row={row}
                onSetStatus={onSetStatus}
                onMatch={onMatch}
                onUnlink={onUnlink}
              />
            ))
          )}
        </TableBody>
      </Table>
    </Card>
  )
}

function ReimbursementRow({
  row,
  onSetStatus,
  onMatch,
  onUnlink,
}: {
  row: ReimbursementView
  onSetStatus: (row: ReimbursementView, status: ReimbursementStatus) => void
  onMatch: (row: ReimbursementView) => void
  onUnlink: (row: ReimbursementView) => void
}) {
  const amountNum = Number(row.amount) || 0
  const overdue = row.effectiveStatus === 'overdue'
  return (
    <TableRow>
      <TableCell>
        <div>{row.partyLabel}</div>
        {row.contactId != null && <div className="muted text-xs">contact</div>}
      </TableCell>
      <TableCell>{formatMoney(amountNum, row.currency)}</TableCell>
      <TableCell>
        {row.dueDate ? (
          <div className={overdue ? 'text-destructive' : ''}>
            <div>
              {overdue && (
                <AlertTriangle className="inline-block size-3 align-text-bottom" />
              )}{' '}
              {row.dueDate}
            </div>
            {row.daysUntilDue != null && (
              <div className="text-xs">
                {row.daysUntilDue < 0
                  ? `${Math.abs(row.daysUntilDue)}d overdue`
                  : `in ${row.daysUntilDue}d`}
              </div>
            )}
          </div>
        ) : (
          <span className="muted">—</span>
        )}
      </TableCell>
      <TableCell>
        <Badge variant={STATUS_VARIANT[row.effectiveStatus]}>
          {STATUS_LABEL[row.effectiveStatus]}
        </Badge>
      </TableCell>
      <TableCell>
        {row.transaction ? (
          <div className="text-xs">
            <div>{row.transaction.merchant ?? '—'}</div>
            <div className="muted">{row.transaction.date}</div>
          </div>
        ) : (
          <span className="muted">—</span>
        )}
        {row.repaymentTransaction && (
          <div className="muted text-xs mt-1">
            <Link2 className="inline-block size-3 align-text-bottom" /> repaid{' '}
            {row.repaymentTransaction.date}
          </div>
        )}
      </TableCell>
      <TableCell>
        <div className="flex flex-wrap justify-end gap-1">
          {row.status !== 'received' && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => onMatch(row)}
              title={
                row.repaymentTransactionId != null
                  ? 'Already matched — open to re-link'
                  : 'Find and link the repayment transaction'
              }
            >
              {row.repaymentTransactionId != null ? 'Re-match' : 'Match'}
            </Button>
          )}
          {row.status !== 'received' && (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => onSetStatus(row, 'received')}
              title="Mark as received"
            >
              <CheckCircle2 className="size-3" /> Received
            </Button>
          )}
          {row.status === 'received' && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => onUnlink(row)}
              title="Reopen this claim"
            >
              <Clock className="size-3" /> Reopen
            </Button>
          )}
          {row.status !== 'waived' && row.status !== 'received' && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => onSetStatus(row, 'waived')}
              title="Waive (write off) this claim"
            >
              Waive
            </Button>
          )}
        </div>
      </TableCell>
    </TableRow>
  )
}

function MatchDialog({
  row,
  onClose,
  onLinked,
}: {
  row: ReimbursementView
  onClose: () => void
  onLinked: () => void
}) {
  const { showToast } = useToast()
  const [contacts, setContacts] = useState<Contact[] | null>(null)
  const [candidates, setCandidates] = useState<RepaymentCandidate[]>([])
  const [loading, setLoading] = useState(true)
  const [candidateError, setCandidateError] = useState<string | null>(null)
  const [linkingId, setLinkingId] = useState<number | null>(null)

  useEffect(() => {
    let cancelled = false
    async function load() {
      setLoading(true)
      setCandidateError(null)
      try {
        const contactList = await getJson<Contact[]>('/api/contacts')
        if (cancelled) return
        setContacts(contactList)
        if (contactList.length === 0) {
          setLoading(false)
          return
        }
        const res = await getJson<RepaymentCandidatesResponse>(
          `/api/reimbursements/${row.id}/match-candidates`,
        )
        if (!cancelled) setCandidates(res.data)
      } catch (e) {
        if (!cancelled) {
          setCandidateError(e instanceof Error ? e.message : 'Failed to load candidates')
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [row.id])

  async function link(transactionId: number) {
    setLinkingId(transactionId)
    try {
      await postJson<ReimbursementItemResponse>(
        `/api/reimbursements/${row.id}/link-repayment`,
        { transactionId },
      )
      showToast({ title: 'Repayment linked', variant: 'success' })
      onLinked()
    } catch (e) {
      showToast({
        title: e instanceof Error ? e.message : 'Link failed',
        variant: 'destructive',
      })
      setLinkingId(null)
    }
  }

  const hasContact = row.contactId != null
  const noContacts = contacts !== null && contacts.length === 0

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Match a repayment for ${row.partyLabel}`}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <Card className="w-full max-w-lg p-5">
        <h2 className="mb-1 text-lg font-semibold">Match a repayment</h2>
        <p className="muted text-sm mb-4">
          {row.partyLabel} · {formatMoney(Number(row.amount) || 0, row.currency)}
          {row.dueDate ? ` · due ${row.dueDate}` : ''}
        </p>

        {loading ? (
          <p className="muted text-sm">Searching for likely repayments…</p>
        ) : noContacts ? (
          <div className="space-y-3">
            <p className="font-medium">No contacts yet.</p>
            <p className="muted text-sm">Reimbursements track who owes you. Add a contact first.</p>
            <Link to="/settings/contacts" onClick={onClose}>
              <Button type="button" size="sm">Add a contact</Button>
            </Link>
          </div>
        ) : candidateError ? (
          <div className="space-y-2">
            <p className="text-sm text-destructive">Couldn't load candidates. {candidateError}</p>
            <Button type="button" variant="outline" size="sm" onClick={() => {
              setCandidateError(null)
              setLoading(true)
              void getJson<RepaymentCandidatesResponse>(`/api/reimbursements/${row.id}/match-candidates`)
                .then((res) => setCandidates(res.data))
                .catch((e) => setCandidateError(e instanceof Error ? e.message : 'Retry failed'))
                .finally(() => setLoading(false))
            }}>Retry</Button>
          </div>
        ) : candidates.length === 0 ? (
          <div className="space-y-3">
            {!hasContact && (
              <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm dark:border-amber-800 dark:bg-amber-950">
                <p className="text-amber-800 dark:text-amber-200">
                  This reimbursement has no linked contact.{' '}
                  <Link
                    to="/settings/contacts"
                    className="underline hover:no-underline"
                    onClick={onClose}
                  >
                    Add a contact
                  </Link>{' '}
                  to make future matching easier.
                </p>
              </div>
            )}
            <p className="muted text-sm">
              No likely repayment transactions found. The repayment should be an
              incoming credit in {row.currency} on or after the original charge.
            </p>
            <p className="text-sm font-medium">Try one of these:</p>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={onClose}
                title="Go to items to widen date range"
              >
                Widen date range
              </Button>
              <Link to="/accounts" onClick={onClose}>
                <Button type="button" variant="outline" size="sm">
                  Check account selection
                </Button>
              </Link>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={onClose}
                title="Edit this reimbursement's date"
              >
                Edit reimbursement date
              </Button>
            </div>
          </div>
        ) : (
          <ul className="flex flex-col gap-2">
            {candidates.map((c) => (
              <li
                key={c.transactionId}
                className="flex items-center justify-between rounded-md border border-input p-2"
              >
                <div className="text-sm">
                  <div>
                    {c.merchant ?? 'Transaction'} ·{' '}
                    {formatMoney(Number(c.amount) || 0, c.currency)}
                  </div>
                  <div className="muted text-xs">
                    {c.date} · match {Math.round(c.score * 100)}%
                  </div>
                </div>
                <Button
                  type="button"
                  size="sm"
                  disabled={linkingId != null}
                  onClick={() => link(c.transactionId)}
                >
                  {linkingId === c.transactionId ? 'Linking…' : 'Link'}
                </Button>
              </li>
            ))}
          </ul>
        )}
        <div className="mt-4 flex justify-end">
          <Button type="button" variant="outline" onClick={onClose}>
            Close
          </Button>
        </div>
      </Card>
    </div>
  )
}
