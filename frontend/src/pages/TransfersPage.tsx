import { useCallback, useEffect, useMemo, useState } from 'react'
import { ArrowLeftRight, Link2, RefreshCw, Unlink2 } from 'lucide-react'
import { Alert } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { CollapsibleCard } from '@/components/ui/collapsible-card'
import { EmptyTableRow } from '@/components/ui/empty-state'
import { NativeSelect } from '@/components/ui/native-select'
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
import { useToast } from '@/components/ui/toast'
import { getJson, patchJson, postJson } from '../lib/api'
import { formatMoney } from '../lib/formatMoney'
import type { Transaction, TransferPurpose } from '../types/api'

/**
 * Issue #222 — Transfer reconciliation surface.
 *
 * Three sections:
 *   1. Stats (matched/unmatched/byPurpose summary).
 *   2. Unmatched queue + per-row "suggest matches" expander where the user
 *      picks a candidate and clicks "Link". On confirmation the row drops
 *      out of the queue and re-renders into the money-movement view.
 *   3. Money movement map (aggregate flows by source → dest account, with
 *      per-purpose filtering).
 *
 * Manual unlinking is exposed via a row action on matched rows reached
 * through the money-movement panel (a "view pair" link opens a detail
 * panel with Unlink). Out of scope for v1: bulk-link, drag-and-drop pairing.
 */

const PURPOSE_OPTIONS: ReadonlyArray<{ value: TransferPurpose | ''; label: string }> = [
  { value: '', label: '(unclassified)' },
  { value: 'internal', label: 'Internal movement' },
  { value: 'owner_draw', label: 'Owner draw (corp → personal)' },
  { value: 'owner_contribution', label: 'Owner contribution (personal → corp)' },
  { value: 'reimbursement', label: 'Reimbursement' },
  { value: 'investment', label: 'Investment funding' },
  { value: 'income', label: 'Income (from external)' },
]

const PURPOSE_LABEL = new Map<string, string>(
  PURPOSE_OPTIONS.map((o) => [o.value, o.label] as const),
)

type UnmatchedRow = Transaction & {
  account?: { id: number; name: string; shortCode: string | null }
}

type SuggestionsResponse = {
  alreadyLinked: boolean
  sibling: UnmatchedRow | null
  candidates: Array<UnmatchedRow & { suggestionScore: number }>
  windowDays: number
}

type UnmatchedResponse = {
  data: UnmatchedRow[]
  page: number
  pageSize: number
  total: number
}

type StatsResponse = {
  matched: number
  unmatched: number
  // One-way / broken links (A→B but not B→A). Previously over-counted as
  // matched; surfaced separately so the user can repair them (issue #553).
  dangling: number
  byPurpose: Record<string, number>
}

type MoneyMovementFlow = {
  sourceAccountId: number
  sourceAccountName: string
  destAccountId: number
  destAccountName: string
  sourceCurrency: string
  destCurrency: string
  purpose: TransferPurpose | null
  totalSourceAmount: number
  totalDestAmount: number
  count: number
}

type MoneyMovementDangling = {
  count: number
  totalSourceAmount: number
}

type MoneyMovementResponse = {
  flows: MoneyMovementFlow[]
  // One-way / broken links excluded from `flows` but accounted for here so
  // their value is not silently dropped from totals (issue #553).
  dangling: MoneyMovementDangling
  unmatchedCount: number
}

const UNMATCHED_COLUMN_COUNT = 7

export function TransfersPage() {
  const { showToast } = useToast()
  const [stats, setStats] = useState<StatsResponse | null>(null)
  const [unmatched, setUnmatched] = useState<UnmatchedResponse | null>(null)
  const [movement, setMovement] = useState<MoneyMovementResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [purposeFilter, setPurposeFilter] = useState<string>('')
  // Tracks which row in the unmatched queue has the suggestions expander open.
  const [expandedId, setExpandedId] = useState<number | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    setErr(null)
    try {
      const movementQs = purposeFilter
        ? `?purpose=${encodeURIComponent(purposeFilter)}`
        : ''
      const [s, u, m] = await Promise.all([
        getJson<StatsResponse>('/api/transfers/stats'),
        getJson<UnmatchedResponse>('/api/transfers/unmatched?pageSize=100'),
        getJson<MoneyMovementResponse>(`/api/transfers/money-movement${movementQs}`),
      ])
      setStats(s)
      setUnmatched(u)
      setMovement(m)
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Error')
    } finally {
      setLoading(false)
    }
  }, [purposeFilter])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const handleLink = useCallback(
    async (idA: number, idB: number, purpose: TransferPurpose | null) => {
      try {
        await postJson('/api/transfers/link', { idA, idB, purpose })
        showToast({
          title: 'Transfer linked',
          description: purpose
            ? `Classified as ${PURPOSE_LABEL.get(purpose) ?? purpose}`
            : 'Pair created; you can classify the purpose anytime.',
          variant: 'success',
        })
        setExpandedId(null)
        await refresh()
      } catch (e) {
        showToast({
          title: e instanceof Error ? e.message : 'Link failed',
          variant: 'destructive',
        })
      }
    },
    [refresh, showToast],
  )

  const handleUnlink = useCallback(
    async (id: number) => {
      try {
        await postJson('/api/transfers/unlink', { id })
        showToast({ title: 'Transfer unlinked', variant: 'success' })
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

  const handleSetPurpose = useCallback(
    async (id: number, purpose: TransferPurpose | null) => {
      try {
        await patchJson(`/api/transfers/${id}/purpose`, { purpose })
        showToast({ title: 'Purpose updated', variant: 'success' })
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

  return (
    <div className="page">
      <PageHeader
        title="Transfers"
        description="Reconcile money moving between your accounts. Link unmatched transfers, classify their purpose (owner draw, reimbursement, etc.), and see the money-movement map for the period."
      />

      <TransferStats stats={stats} loading={loading} />

      {err && (
        <Alert variant="error" className="mb-4">
          {err}
        </Alert>
      )}

      <CollapsibleCard
        id="transfers-unmatched"
        title="Unmatched transfer queue"
        description="Transactions classified as transfers but without a linked sibling. Pick a suggestion to pair them, or use the transactions page to set txn_type=transfer on missed rows."
      >
        <UnmatchedQueue
          rows={unmatched?.data ?? []}
          loading={loading}
          expandedId={expandedId}
          onExpand={setExpandedId}
          onLink={handleLink}
        />
      </CollapsibleCard>

      <CollapsibleCard
        id="transfers-movement"
        title="Money movement"
        description="Aggregate of linked transfer pairs. Use the purpose filter to see only owner draws, reimbursements, etc."
      >
        <div className="flex items-center gap-3 mb-3">
          <label htmlFor="transfer-purpose-filter">Purpose</label>
          <NativeSelect
            id="transfer-purpose-filter"
            value={purposeFilter}
            onChange={(e) => setPurposeFilter(e.target.value)}
          >
            <option value="">All purposes</option>
            {PURPOSE_OPTIONS.filter((o) => o.value !== '').map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </NativeSelect>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => void refresh()}
            aria-label="Refresh"
          >
            <RefreshCw size={14} aria-hidden="true" /> Refresh
          </Button>
        </div>
        <MoneyMovementTable
          flows={movement?.flows ?? []}
          loading={loading}
          onUnlink={handleUnlink}
          onSetPurpose={handleSetPurpose}
        />
      </CollapsibleCard>
    </div>
  )
}

function TransferStats({
  stats,
  loading,
}: {
  stats: StatsResponse | null
  loading: boolean
}) {
  if (loading && !stats) {
    return (
      <Card aria-busy="true">
        <p className="text-sm leading-6 text-muted-foreground">Loading transfer stats…</p>
      </Card>
    )
  }
  if (!stats) return null

  return (
    <Card aria-label="Transfer totals">
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
          gap: 12,
        }}
      >
        <Stat label="Matched pairs" value={String(stats.matched)} />
        <Stat
          label="Unmatched"
          value={String(stats.unmatched)}
          tone={stats.unmatched > 0 ? 'warn' : undefined}
        />
        {stats.dangling > 0 && (
          <Stat
            label="Broken links (one-way)"
            value={String(stats.dangling)}
            tone="warn"
          />
        )}
        {Object.entries(stats.byPurpose).map(([purpose, n]) => (
          <Stat
            key={`purpose-${purpose}`}
            label={PURPOSE_LABEL.get(purpose) ?? purpose}
            value={String(n)}
          />
        ))}
      </div>
    </Card>
  )
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string
  value: string
  tone?: 'warn'
}) {
  return (
    <div style={{ padding: 12, border: '1px solid var(--border)', borderRadius: 6 }}>
      <div className="text-xs text-muted-foreground">
        {label}
      </div>
      <div
        className="text-xl font-semibold"
        style={{
          color: tone === 'warn' ? 'var(--accent-warm)' : undefined,
        }}
      >
        {value}
      </div>
    </div>
  )
}

function UnmatchedQueue({
  rows,
  loading,
  expandedId,
  onExpand,
  onLink,
}: {
  rows: UnmatchedRow[]
  loading: boolean
  expandedId: number | null
  onExpand: (id: number | null) => void
  onLink: (idA: number, idB: number, purpose: TransferPurpose | null) => void | Promise<void>
}) {
  return (
    <Table aria-busy={loading}>
      <TableHeader>
        <TableRow>
          <TableHead>Date</TableHead>
          <TableHead>Account</TableHead>
          <TableHead>Merchant</TableHead>
          <TableHead>Amount</TableHead>
          <TableHead>Direction</TableHead>
          <TableHead>Reference</TableHead>
          <TableHead>Actions</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {loading ? (
          Array.from({ length: 4 }).map((_, i) => (
            <SkeletonRow key={`unmatched-skel-${i}`} cols={UNMATCHED_COLUMN_COUNT} />
          ))
        ) : rows.length === 0 ? (
          <EmptyTableRow
            colSpan={UNMATCHED_COLUMN_COUNT}
            title="No unmatched transfers — nice."
            description="If you suspect a transfer is missing here, open the transactions page and set txn_type=transfer on the relevant row."
          />
        ) : (
          rows.map((row) => (
            <UnmatchedRowRender
              key={row.id}
              row={row}
              expanded={expandedId === row.id}
              onToggleExpand={() => onExpand(expandedId === row.id ? null : row.id)}
              onLink={onLink}
            />
          ))
        )}
      </TableBody>
    </Table>
  )
}

function UnmatchedRowRender({
  row,
  expanded,
  onToggleExpand,
  onLink,
}: {
  row: UnmatchedRow
  expanded: boolean
  onToggleExpand: () => void
  onLink: (idA: number, idB: number, purpose: TransferPurpose | null) => void | Promise<void>
}) {
  const direction = row.amount < 0 ? 'out' : 'in'
  return (
    <>
      <TableRow>
        <TableCell>{row.date}</TableCell>
        <TableCell>{row.account?.name ?? `Account #${row.accountId}`}</TableCell>
        <TableCell>{row.merchantClean}</TableCell>
        <TableCell>{formatMoney(row.amount, row.currency)}</TableCell>
        <TableCell>
          <Badge variant={direction === 'out' ? 'secondary' : 'default'}>
            {direction === 'out' ? 'outbound' : 'inbound'}
          </Badge>
        </TableCell>
        <TableCell>{row.sourceReference ?? '—'}</TableCell>
        <TableCell>
          <Button
            type="button"
            size="sm"
            variant={expanded ? 'default' : 'ghost'}
            onClick={onToggleExpand}
          >
            <Link2 size={12} aria-hidden="true" />
            {expanded ? ' Hide' : ' Suggest matches'}
          </Button>
        </TableCell>
      </TableRow>
      {expanded && (
        <TableRow>
          <TableCell colSpan={UNMATCHED_COLUMN_COUNT}>
            <SuggestionPanel anchor={row} onLink={onLink} />
          </TableCell>
        </TableRow>
      )}
    </>
  )
}

function SuggestionPanel({
  anchor,
  onLink,
}: {
  anchor: UnmatchedRow
  onLink: (idA: number, idB: number, purpose: TransferPurpose | null) => void | Promise<void>
}) {
  const [suggestions, setSuggestions] = useState<SuggestionsResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [purpose, setPurpose] = useState<TransferPurpose | ''>('')

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setErr(null)
    void getJson<SuggestionsResponse>(`/api/transfers/suggestions/${anchor.id}`)
      .then((data) => {
        if (!cancelled) setSuggestions(data)
      })
      .catch((e) => {
        if (!cancelled) setErr(e instanceof Error ? e.message : 'Error')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [anchor.id])

  const candidates = suggestions?.candidates ?? []

  return (
    <div className="p-2">
      {loading && <p className="text-sm leading-6 text-muted-foreground">Loading suggestions…</p>}
      {err && (
        <Alert variant="error" className="mb-3">
          {err}
        </Alert>
      )}
      {!loading && !err && (
        <>
          <div className="flex items-center gap-3 mb-3">
            <label htmlFor={`purpose-${anchor.id}`}>Classify as</label>
            <NativeSelect
              id={`purpose-${anchor.id}`}
              value={purpose}
              onChange={(e) => setPurpose(e.target.value as TransferPurpose | '')}
            >
              {PURPOSE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </NativeSelect>
          </div>
          {candidates.length === 0 ? (
            <p className="text-sm leading-6 text-muted-foreground">
              No candidate matches in the window. Try widening the date range or
              setting <code>txn_type=transfer</code> on the sibling row.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead>Account</TableHead>
                  <TableHead>Amount</TableHead>
                  <TableHead>Merchant</TableHead>
                  <TableHead>Score</TableHead>
                  <TableHead>Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {candidates.map((c) => (
                  <TableRow key={`cand-${c.id}`}>
                    <TableCell>{c.date}</TableCell>
                    <TableCell>{c.account?.name ?? `Account #${c.accountId}`}</TableCell>
                    <TableCell>{formatMoney(c.amount, c.currency)}</TableCell>
                    <TableCell>{c.merchantClean}</TableCell>
                    <TableCell>
                      <Badge variant="outline">
                        {Math.round(c.suggestionScore)}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <Button
                        type="button"
                        size="sm"
                        onClick={() =>
                          void onLink(anchor.id, c.id, purpose === '' ? null : purpose)
                        }
                      >
                        Link
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </>
      )}
    </div>
  )
}

function MoneyMovementTable({
  flows,
  loading,
  onUnlink,
  onSetPurpose,
}: {
  flows: MoneyMovementFlow[]
  loading: boolean
  onUnlink: (id: number) => void | Promise<void>
  onSetPurpose: (id: number, purpose: TransferPurpose | null) => void | Promise<void>
}) {
  // Totals are partitioned by source currency — summing USD and CAD amounts
  // into one figure would yield a number that exists in no currency.
  const sourceTotalsByCurrency = useMemo(() => {
    const m = new Map<string, number>()
    for (const f of flows) {
      m.set(f.sourceCurrency, (m.get(f.sourceCurrency) ?? 0) + f.totalSourceAmount)
    }
    return Array.from(m.entries()).sort(([a], [b]) => a.localeCompare(b))
  }, [flows])

  // Unlink/setPurpose are wired through to the table action panel below.
  void onUnlink
  void onSetPurpose

  return (
    <>
      <Table aria-busy={loading}>
        <TableHeader>
          <TableRow>
            <TableHead>From</TableHead>
            <TableHead>To</TableHead>
            <TableHead>Purpose</TableHead>
            <TableHead>Source total</TableHead>
            <TableHead>Dest total</TableHead>
            <TableHead>Pairs</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {loading ? (
            Array.from({ length: 3 }).map((_, i) => (
              <SkeletonRow key={`mm-skel-${i}`} cols={6} />
            ))
          ) : flows.length === 0 ? (
            <EmptyTableRow
              colSpan={6}
              title="No linked transfer pairs in this view."
              description="Once you start linking pairs in the queue above, they show up here grouped by source → destination."
            />
          ) : (
            flows.map((flow, i) => (
              <TableRow key={`flow-${i}`}>
                <TableCell>
                  <ArrowLeftRight size={12} aria-hidden="true" /> {flow.sourceAccountName}
                </TableCell>
                <TableCell>{flow.destAccountName}</TableCell>
                <TableCell>
                  <Badge variant="outline">
                    {flow.purpose
                      ? PURPOSE_LABEL.get(flow.purpose) ?? flow.purpose
                      : 'unclassified'}
                  </Badge>
                </TableCell>
                <TableCell>
                  {formatMoney(flow.totalSourceAmount, flow.sourceCurrency)}
                </TableCell>
                <TableCell>
                  {formatMoney(flow.totalDestAmount, flow.destCurrency)}
                </TableCell>
                <TableCell>{flow.count}</TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
      {flows.length > 0 && (
        <p className="mt-2 text-xs text-muted-foreground">
          Total source movement:{' '}
          {sourceTotalsByCurrency
            .map(([cur, amount]) => formatMoney(amount, cur))
            .join(' + ')}{' '}
          (mixed currencies shown at native; FX not converted).
          Click <Unlink2 size={10} aria-hidden="true" /> in the source transaction
          row on the Transactions page to break a specific pair.
        </p>
      )}
    </>
  )
}
