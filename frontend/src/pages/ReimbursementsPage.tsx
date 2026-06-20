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
import { useNavigate } from 'react-router-dom'
import { Alert } from '@connor-adams/designsystem'
import { Badge } from '@connor-adams/designsystem'
import { Button } from '@connor-adams/designsystem'
import { Card } from '@connor-adams/designsystem'
import { EmptyTableRow } from '@/lib/ds-extras'
import { PageHeader } from '@/components/ui/page-header'
import { SkeletonRow } from '@/lib/ds-extras'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@connor-adams/designsystem'
import { Tabs } from '@connor-adams/designsystem'
import { useToast } from '@/components/ui/toast'
import { getJson, postJson, patchJson } from '../lib/api'
import { todayDateInputValue } from '../lib/dateInput'
import { formatMoneyOr } from '../lib/formatMoney'
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

/** Coerce a backend money value (sent as a decimal string) to a number for
 *  display, returning `null` for nullish/empty/NaN inputs so a missing amount
 *  renders the `—` placeholder instead of a misleading `$0.00`. A real `0`
 *  (or `"0"`) is preserved. */
function toAmount(value: string | number | null | undefined): number | null {
  if (value == null || value === '') return null
  const n = Number(value)
  return Number.isNaN(n) ? null : n
}

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
    // Pass the browser's local calendar day so overdue derivation flips at
    // the user's midnight, not UTC's (hours early for behind-UTC users).
    const today = todayDateInputValue()
    switch (which) {
      case 'outstanding':
        // Open claims (expected) — the derived-overdue ones surface here too.
        return `/api/reimbursements?status=expected&today=${today}`
      case 'overdue':
        return `/api/reimbursements/overdue?today=${today}`
      case 'received':
        return `/api/reimbursements?status=received&today=${today}`
      case 'all':
        return `/api/reimbursements?today=${today}`
    }
  }, [])

  const refresh = useCallback(async () => {
    setLoading(true)
    setErr(null)
    try {
      const [list, sum] = await Promise.all([
        getJson<ReimbursementListResponse>(endpointForTab(tab)),
        getJson<ReimbursementSummaryResponse>(
          `/api/reimbursements/summary?today=${todayDateInputValue()}`,
        ),
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
        <Alert variant="error" className="mb-4">
          {err}
        </Alert>
      )}

      {(['outstanding', 'overdue', 'received', 'all'] as const).map((key) =>
        tab === key ? (
          <div key={key} role="tabpanel">
            <ReimbursementTable
              rows={rows}
              loading={loading}
              emptyTitle={emptyTitleFor(key)}
              onSetStatus={setStatus}
              onMatch={setMatching}
              onUnlink={unlink}
            />
          </div>
        ) : null,
      )}

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
          <div className="text-xs uppercase tracking-wide text-muted-foreground">Outstanding</div>
          {currencies.length === 0 ? (
            <div className="text-lg font-semibold">—</div>
          ) : (
            <div className="flex flex-wrap gap-3">
              {currencies.map((cur) => (
                <span key={cur} className="text-lg font-semibold">
                  {formatMoneyOr(toAmount(summary.outstandingByCurrency[cur]), cur)}
                </span>
              ))}
            </div>
          )}
        </div>
        <div>
          <div className="text-xs uppercase tracking-wide text-muted-foreground">Overdue</div>
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
          <div className="text-xs uppercase tracking-wide text-muted-foreground">Total claims</div>
          <div className="text-lg font-semibold">{summary.totalCount}</div>
        </div>
      </div>

      {summary.groups.length > 0 && (
        <div className="mt-4">
          <div className="mb-2 text-xs uppercase tracking-wide text-muted-foreground">
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
                    {formatMoneyOr(toAmount(g.outstanding), g.currency)}
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
      <Table>
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
  const amountNum = toAmount(row.amount)
  const overdue = row.effectiveStatus === 'overdue'
  return (
    <TableRow>
      <TableCell>
        <div>{row.partyLabel}</div>
        {row.contactId != null && <div className="text-xs text-muted-foreground">contact</div>}
      </TableCell>
      <TableCell>{formatMoneyOr(amountNum, row.currency)}</TableCell>
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
          <span className="text-sm text-muted-foreground">—</span>
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
            <div className="text-muted-foreground">{row.transaction.date}</div>
          </div>
        ) : (
          <span className="text-sm text-muted-foreground">—</span>
        )}
        {row.repaymentTransaction && (
          <div className="text-xs mt-1 text-muted-foreground">
            <Link2 className="inline-block size-3 align-text-bottom" /> repaid{' '}
            {row.repaymentTransaction.date}
          </div>
        )}
      </TableCell>
      <TableCell>
        <div className="flex flex-wrap justify-end gap-1">
          {row.status !== 'received' && (() => {
            const alreadyMatched = row.repaymentTransaction != null
            const matchTitle = alreadyMatched
              ? 'Reimbursement already matched'
              : 'Find and link the repayment transaction'
            return (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={alreadyMatched}
                onClick={() => !alreadyMatched && onMatch(row)}
                title={matchTitle}
                aria-disabled={alreadyMatched}
              >
                Match
              </Button>
            )
          })()}
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
  const navigate = useNavigate()
  const [contacts, setContacts] = useState<Contact[]>([])
  const [contactsLoaded, setContactsLoaded] = useState(false)
  const [candidates, setCandidates] = useState<RepaymentCandidate[]>([])
  const [loading, setLoading] = useState(true)
  const [fetchError, setFetchError] = useState<string | null>(null)
  const [linkingId, setLinkingId] = useState<number | null>(null)
  const [widened, setWidened] = useState(false)
  const [showAccountHint, setShowAccountHint] = useState(false)

  // Fetch contacts first — if none exist, skip loading candidates
  useEffect(() => {
    let cancelled = false
    void getJson<Contact[]>('/api/contacts').then((c) => {
      if (!cancelled) {
        setContacts(c)
        setContactsLoaded(true)
      }
    }).catch(() => {
      if (!cancelled) setContactsLoaded(true)
    })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    if (!contactsLoaded || contacts.length === 0) {
      setLoading(false)
      return
    }
    let cancelled = false
    async function load() {
      setLoading(true)
      setFetchError(null)
      try {
        const res = await getJson<RepaymentCandidatesResponse>(
          `/api/reimbursements/${row.id}/match-candidates`,
        )
        if (!cancelled) setCandidates(res.data)
      } catch (e) {
        if (!cancelled) {
          setFetchError(e instanceof Error ? e.message : 'Failed to load candidates')
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void load()
    return () => { cancelled = true }
  }, [row.id, contactsLoaded, contacts.length])

  // Client-side date filter: show candidates within 30 days of outlay date unless widened
  const outlayDate = row.transaction?.date
  const visibleCandidates = widened || !outlayDate
    ? candidates
    : candidates.filter((c) => {
        const diff = (new Date(c.date).getTime() - new Date(outlayDate).getTime()) / 86400000
        return diff <= 30
      })

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

  const isLoading = !contactsLoaded || loading

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
        <p className="text-sm mb-4 text-muted-foreground">
          {row.partyLabel} · {formatMoneyOr(toAmount(row.amount), row.currency)}
          {row.dueDate ? ` · due ${row.dueDate}` : ''}
        </p>

        {isLoading ? (
          <p className="text-sm text-muted-foreground">Searching for likely repayments…</p>
        ) : contacts.length === 0 ? (
          <div className="text-sm space-y-2">
            <p className="font-medium">No contacts yet.</p>
            <p className="text-muted-foreground">Reimbursements track who owes you. Add a contact first.</p>
            <Button
              type="button"
              size="sm"
              onClick={() => { onClose(); navigate('/settings/contacts') }}
            >
              Add a contact
            </Button>
          </div>
        ) : fetchError ? (
          <div className="text-sm space-y-2">
            <p className="text-destructive">Couldn't load candidates. Retry.</p>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => {
                setFetchError(null)
                setLoading(true)
                void getJson<RepaymentCandidatesResponse>(
                  `/api/reimbursements/${row.id}/match-candidates`,
                ).then((res) => {
                  setCandidates(res.data)
                  setLoading(false)
                }).catch((e) => {
                  setFetchError(e instanceof Error ? e.message : 'Failed to load candidates')
                  setLoading(false)
                })
              }}
            >
              Retry
            </Button>
          </div>
        ) : visibleCandidates.length === 0 ? (
          <div className="text-sm space-y-3">
            <p className="font-medium">No likely repayment transactions found</p>
            {!row.contactId && (
              <p className="text-warning text-xs">
                Set an expected contact on this reimbursement to improve matching.
              </p>
            )}
            <p className="text-muted-foreground">Try one of these:</p>
            <div className="flex flex-col gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={widened}
                title={widened ? 'Already at maximum.' : undefined}
                onClick={() => setWidened(true)}
              >
                Widen date range {widened ? '(max)' : '(30 → 90 days)'}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => setShowAccountHint((v) => !v)}
              >
                Check account selection
              </Button>
              {showAccountHint && (
                <div className="rounded bg-warning-bg border border-warning p-2 text-xs text-warning">
                  Matching searches all accounts visible to you in {row.currency}.
                  If the repayment came in via a different currency or account,
                  it won't appear here.{' '}
                  <Button
                    variant="link"
                    className="inline h-auto p-0"
                    onClick={() => { onClose(); navigate('/settings') }}
                  >
                    Edit in settings
                  </Button>
                </div>
              )}
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={onClose}
              >
                Edit reimbursement date
              </Button>
            </div>
          </div>
        ) : (
          <ul className="flex flex-col gap-2">
            {visibleCandidates.map((c) => (
              <li
                key={c.transactionId}
                className="flex items-center justify-between rounded-md border border-input p-2"
              >
                <div className="text-sm">
                  <div>
                    {c.merchant ?? 'Transaction'} ·{' '}
                    {formatMoneyOr(toAmount(c.amount), c.currency)}
                  </div>
                  <div className="text-xs text-muted-foreground">
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
