import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { PageHeader } from '@/components/ui/page-header'
import { EmptyState } from '@/components/ui/empty-state'
import { SeverityBadge, type InsightSeverity } from '@/components/ai/SeverityBadge'
import { getJson, postJson } from '@/lib/api'

// ---------------------------------------------------------------------------
// Types — mirror backend/src/reviewItems/normalize.ts
// ---------------------------------------------------------------------------

type ReviewItemSource = 'ai-suggestion' | 'ai-review' | 'cfo-briefing' | 'chat-proposal'
type ReviewItemCommonStatus = 'pending' | 'resolved' | 'dismissed' | 'expired'
type ReviewItemSubjectType =
  | 'transaction'
  | 'receipt'
  | 'rule'
  | 'event'
  | 'subscription'
  | 'import'
  | 'chat-message'
  | null

type ReviewItem = {
  id: string
  source: ReviewItemSource
  subject_type: ReviewItemSubjectType
  subject_id: string | null
  payload: Record<string, unknown>
  status_common: ReviewItemCommonStatus
  native_status: string
  created_at: string
  resolved_at: string | null
}

type ListResponse = { data: ReviewItem[]; nextCursor: string | null }

const ALL_SOURCES: ReviewItemSource[] = [
  'ai-suggestion',
  'ai-review',
  'cfo-briefing',
  'chat-proposal',
]

const SOURCE_LABEL: Record<ReviewItemSource, string> = {
  'ai-suggestion': 'AI suggestions',
  'ai-review': 'AI review',
  'cfo-briefing': 'CFO briefings',
  'chat-proposal': 'Chat proposals',
}

const ALL_STATUSES: ReviewItemCommonStatus[] = ['pending', 'resolved', 'dismissed', 'expired']

const STATUS_LABEL: Record<ReviewItemCommonStatus, string> = {
  pending: 'Pending',
  resolved: 'Resolved',
  dismissed: 'Dismissed',
  expired: 'Expired',
}

// ---------------------------------------------------------------------------
// Saved views (issue #378 default set)
// ---------------------------------------------------------------------------

type SavedView = {
  key: string
  label: string
  sources: ReviewItemSource[]
  statuses: ReviewItemCommonStatus[]
}

const SAVED_VIEWS: SavedView[] = [
  { key: 'ai-suggestions-pending', label: 'AI suggestions (pending)', sources: ['ai-suggestion'], statuses: ['pending'] },
  { key: 'review-queue-pending', label: 'Review queue (pending)', sources: ['ai-review'], statuses: ['pending'] },
  { key: 'cfo-briefings-pending', label: 'CFO briefings (pending)', sources: ['cfo-briefing'], statuses: ['pending'] },
  { key: 'chat-proposals-pending', label: 'Chat proposals (pending)', sources: ['chat-proposal'], statuses: ['pending'] },
  {
    key: 'all-resolved-30d',
    label: 'All resolved (last 30 days)',
    sources: ALL_SOURCES,
    statuses: ['resolved'],
  },
]

/** Map ?view= query param to a saved view so old-route redirects preselect. */
function savedViewFromParam(param: string | null): SavedView | null {
  if (!param) return null
  return SAVED_VIEWS.find((v) => v.key === param) ?? null
}

// ---------------------------------------------------------------------------
// Composite-id parsing → per-source write endpoints (writes stay per-source)
// ---------------------------------------------------------------------------

type ActionKind = 'accept' | 'dismiss' | 'apply' | 'reject' | 'resolve'

type SourceAction = { label: string; kind: ActionKind; variant: 'primary' | 'secondary' }

const DISMISS_KIND: Record<ReviewItemSource, ActionKind> = {
  'ai-suggestion': 'reject',
  'ai-review': 'dismiss',
  'cfo-briefing': 'dismiss',
  'chat-proposal': 'reject',
}

const ACTIONS_BY_SOURCE: Record<ReviewItemSource, SourceAction[]> = {
  'ai-suggestion': [
    { label: 'Apply', kind: 'apply', variant: 'primary' },
    { label: 'Reject', kind: 'reject', variant: 'secondary' },
  ],
  'ai-review': [
    { label: 'Accept', kind: 'accept', variant: 'primary' },
    { label: 'Dismiss', kind: 'dismiss', variant: 'secondary' },
  ],
  'cfo-briefing': [
    { label: 'Resolve', kind: 'resolve', variant: 'primary' },
    { label: 'Dismiss', kind: 'dismiss', variant: 'secondary' },
  ],
  'chat-proposal': [
    { label: 'Apply', kind: 'apply', variant: 'primary' },
    { label: 'Reject', kind: 'reject', variant: 'secondary' },
  ],
}

/**
 * Build the per-source write endpoint path for an action on a review item.
 * The composite id encodes the native key(s):
 *   ai-suggestion:{id}            → /api/ai/suggestions/{id}/{apply|reject}
 *   chat-proposal:{id}            → /api/chat/proposals/{id}/{apply|reject}
 *   ai-review:{runId}:{itemId}    → /api/ai/reviews/{runId}/items/{itemId}/{accept|dismiss}
 *   cfo-briefing:{bId}:{itemId}   → /api/cfo/briefings/{bId}/items/{itemId}/{resolve|dismiss}
 *
 * counterparty_email_match items use a custom endpoint — see writeEmailMatchEndpoint.
 */
function writeEndpoint(item: ReviewItem, kind: ActionKind): string | null {
  const parts = item.id.split(':')
  switch (item.source) {
    case 'ai-suggestion': {
      const id = parts[1]
      if (!id) return null
      return `/api/ai/suggestions/${encodeURIComponent(id)}/${kind}`
    }
    case 'chat-proposal': {
      const id = parts[1]
      if (!id) return null
      return `/api/chat/proposals/${encodeURIComponent(id)}/${kind}`
    }
    case 'ai-review': {
      const runId = parts[1]
      const itemId = parts.slice(2).join(':')
      if (!runId || !itemId) return null
      return `/api/ai/reviews/${encodeURIComponent(runId)}/items/${encodeURIComponent(itemId)}/${kind}`
    }
    case 'cfo-briefing': {
      const briefingId = parts[1]
      const itemId = parts.slice(2).join(':')
      if (!briefingId || !itemId) return null
      return `/api/cfo/briefings/${encodeURIComponent(briefingId)}/items/${encodeURIComponent(itemId)}/${kind}`
    }
    default:
      return null
  }
}

// ---------------------------------------------------------------------------
// Search helper — free text across the payload blob
// ---------------------------------------------------------------------------

function matchesSearch(item: ReviewItem, q: string): boolean {
  if (!q.trim()) return true
  const haystack = JSON.stringify(item.payload).toLowerCase()
  return haystack.includes(q.trim().toLowerCase())
}

// ---------------------------------------------------------------------------
// Per-source card rendering
// ---------------------------------------------------------------------------

function severityOf(payload: Record<string, unknown>): InsightSeverity | null {
  const s = payload.severity
  if (s === 'action' || s === 'watch' || s === 'info') return s
  return null
}

function ActionItemCardBody({ item }: { item: ReviewItem }) {
  const p = item.payload
  const title = typeof p.title === 'string' ? p.title : item.source
  const summary = typeof p.summary === 'string' ? p.summary : ''
  const severity = severityOf(p)
  const link = typeof p.link === 'string' ? p.link : null
  return (
    <div className="min-w-0">
      <div className="flex flex-wrap items-center gap-2">
        <strong>{title}</strong>
        {severity ? <SeverityBadge severity={severity} /> : null}
      </div>
      {summary ? <p className="muted mb-0">{summary}</p> : null}
      {link ? (
        <Link to={link} className="text-sm underline">
          Open
        </Link>
      ) : item.subject_type && item.subject_id ? (
        <p className="muted mb-0 text-xs">
          {item.subject_type} #{item.subject_id}
        </p>
      ) : null}
    </div>
  )
}

function CounterpartyEmailMatchCardBody({ item }: { item: ReviewItem }) {
  const p = item.payload
  const output = p.output as { name?: string; isSelf?: boolean } | null | undefined
  const name = output?.name ?? ''
  const isSelf = output?.isSelf ?? false
  const summary =
    isSelf
      ? 'Interac transfer identified as sent to yourself'
      : `Link ${name} to this transfer?`
  return (
    <div className="min-w-0">
      <div className="flex flex-wrap items-center gap-2">
        <strong>{summary}</strong>
        <Badge variant="outline">counterparty email match</Badge>
      </div>
      {item.subject_type && item.subject_id ? (
        <p className="muted mb-0 text-xs">
          {item.subject_type} #{item.subject_id}
        </p>
      ) : null}
    </div>
  )
}

function AiSuggestionCardBody({ item }: { item: ReviewItem }) {
  const p = item.payload
  const kind = typeof p.kind === 'string' ? p.kind : 'suggestion'
  if (kind === 'counterparty_email_match') {
    return <CounterpartyEmailMatchCardBody item={item} />
  }
  const output = p.output
  let headline = ''
  if (output && typeof output === 'object' && !Array.isArray(output)) {
    const h = (output as Record<string, unknown>).headline
    if (typeof h === 'string') headline = h
  }
  return (
    <div className="min-w-0">
      <div className="flex flex-wrap items-center gap-2">
        <strong>{headline || kind.replace(/_/g, ' ')}</strong>
        <Badge variant="outline">{kind}</Badge>
      </div>
      {item.subject_type && item.subject_id ? (
        <p className="muted mb-0 text-xs">
          {item.subject_type} #{item.subject_id}
        </p>
      ) : null}
    </div>
  )
}

function ChatProposalCardBody({ item }: { item: ReviewItem }) {
  const p = item.payload
  const kind = typeof p.kind === 'string' ? p.kind : 'proposal'
  let matched: number | null = null
  const preview = p.preview
  if (preview && typeof preview === 'object') {
    const m = (preview as Record<string, unknown>).matchedCount
    if (typeof m === 'number') matched = m
  }
  return (
    <div className="min-w-0">
      <div className="flex flex-wrap items-center gap-2">
        <strong>Chat proposal</strong>
        <Badge variant="outline">{kind}</Badge>
      </div>
      <p className="muted mb-0 text-xs">
        {matched != null ? `${matched} transactions matched` : 'Open in chat to review'}
      </p>
    </div>
  )
}

function CardBody({ item }: { item: ReviewItem }) {
  switch (item.source) {
    case 'ai-suggestion':
      return <AiSuggestionCardBody item={item} />
    case 'chat-proposal':
      return <ChatProposalCardBody item={item} />
    case 'ai-review':
    case 'cfo-briefing':
      return <ActionItemCardBody item={item} />
    default:
      return (
        <div>
          <strong>{item.source}</strong>
          <p className="muted mb-0 text-xs">{item.native_status}</p>
        </div>
      )
  }
}

function ReviewItemCard({
  item,
  busy,
  onAction,
}: {
  item: ReviewItem
  busy: boolean
  onAction: (item: ReviewItem, kind: ActionKind) => void
}) {
  const actions = ACTIONS_BY_SOURCE[item.source]
  const isPending = item.status_common === 'pending'
  return (
    <li className="rounded-lg border border-border p-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <CardBody item={item} />
        <div className="flex shrink-0 flex-col items-end gap-2">
          <Badge variant="secondary">{SOURCE_LABEL[item.source]}</Badge>
          <span className="muted text-xs">{item.native_status}</span>
        </div>
      </div>
      {isPending ? (
        <div className="mt-2 flex flex-wrap gap-2">
          {actions.map((a) => (
            <Button
              key={a.kind}
              type="button"
              size="sm"
              variant={a.variant}
              disabled={busy}
              onClick={() => onAction(item, a.kind)}
            >
              {a.label}
            </Button>
          ))}
        </div>
      ) : null}
    </li>
  )
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

function readViewParam(): string | null {
  if (typeof window === 'undefined') return null
  return new URLSearchParams(window.location.search).get('view')
}

export function UnifiedInboxPage() {
  const initialView = savedViewFromParam(readViewParam())
  const [sources, setSources] = useState<Set<ReviewItemSource>>(
    () => new Set(initialView ? initialView.sources : ALL_SOURCES),
  )
  const [statuses, setStatuses] = useState<Set<ReviewItemCommonStatus>>(
    () => new Set(initialView ? initialView.statuses : (['pending'] as ReviewItemCommonStatus[])),
  )
  const [search, setSearch] = useState('')
  const [items, setItems] = useState<ReviewItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [bulkBusy, setBulkBusy] = useState(false)

  const query = useMemo(() => {
    const params = new URLSearchParams()
    // Only send source when it's a strict subset (keeps URLs short for "all").
    if (sources.size > 0 && sources.size < ALL_SOURCES.length) {
      params.set('source', ALL_SOURCES.filter((s) => sources.has(s)).join(','))
    }
    const statusList = ALL_STATUSES.filter((s) => statuses.has(s))
    params.set('status', statusList.length > 0 ? statusList.join(',') : 'pending')
    params.set('limit', '100')
    return params.toString()
  }, [sources, statuses])

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const r = await getJson<ListResponse>(`/api/review-items?${query}`)
      setItems(Array.isArray(r.data) ? r.data : [])
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load inbox')
      setItems([])
    } finally {
      setLoading(false)
    }
  }, [query])

  useEffect(() => {
    void load()
  }, [load])

  const toggleSource = useCallback((s: ReviewItemSource) => {
    setSources((prev) => {
      const next = new Set(prev)
      if (next.has(s) && next.size === 1) {
        // Re-clicking the only active chip resets to "all".
        return new Set(ALL_SOURCES)
      }
      if (next.has(s) && next.size === ALL_SOURCES.length) {
        // From "all", clicking one isolates it.
        return new Set([s])
      }
      if (next.has(s)) next.delete(s)
      else next.add(s)
      return next.size === 0 ? new Set(ALL_SOURCES) : next
    })
  }, [])

  const toggleStatus = useCallback((s: ReviewItemCommonStatus) => {
    setStatuses((prev) => {
      const next = new Set(prev)
      if (next.has(s)) next.delete(s)
      else next.add(s)
      return next.size === 0 ? new Set<ReviewItemCommonStatus>(['pending']) : next
    })
  }, [])

  const applyView = useCallback((view: SavedView) => {
    setSources(new Set(view.sources))
    setStatuses(new Set(view.statuses))
    setSearch('')
  }, [])

  const onAction = useCallback(
    async (item: ReviewItem, kind: ActionKind) => {
      setBusyId(item.id)
      try {
        // counterparty_email_match uses bespoke endpoints:
        //   accept → POST /api/transactions/:txnId/interac-counterparty/accept
        //   reject → POST /api/ai/suggestions/:id/reject  (standard)
        if (
          item.source === 'ai-suggestion' &&
          typeof item.payload.kind === 'string' &&
          item.payload.kind === 'counterparty_email_match'
        ) {
          const nativeId = item.id.split(':')[1]
          if (kind === 'apply') {
            const txnId = item.subject_id
            if (!txnId || !nativeId) return
            await postJson(
              `/api/transactions/${encodeURIComponent(txnId)}/interac-counterparty/accept`,
              { suggestionId: Number(nativeId) },
            )
            await load()
            return
          }
          if (kind === 'reject') {
            if (!nativeId) return
            await postJson(`/api/ai/suggestions/${encodeURIComponent(nativeId)}/reject`)
            await load()
            return
          }
        }
        const path = writeEndpoint(item, kind)
        if (!path) return
        await postJson(path)
        await load()
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Action failed')
      } finally {
        setBusyId(null)
      }
    },
    [load],
  )

  const bulkDismiss = useCallback(async () => {
    const pending = items
      .filter((i) => i.status_common === 'pending' && matchesSearch(i, search))
    if (pending.length === 0) return
    setBulkBusy(true)
    try {
      for (const item of pending) {
        const kind = DISMISS_KIND[item.source]
        const path = writeEndpoint(item, kind)
        if (path) await postJson(path)
      }
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Bulk dismiss failed')
    } finally {
      setBulkBusy(false)
    }
  }, [items, search, load])

  const visible = useMemo(
    () => items.filter((i) => matchesSearch(i, search)),
    [items, search],
  )

  const pendingVisible = useMemo(
    () => visible.filter((i) => i.status_common === 'pending'),
    [visible],
  )

  const allSourcesActive = sources.size === ALL_SOURCES.length

  return (
    <div>
      <PageHeader
        title="Inbox"
        description="Every AI suggestion, review item, CFO briefing action, and chat proposal in one filterable queue."
      />

      <div className="mb-3 flex flex-wrap gap-2" aria-label="Saved views">
        {SAVED_VIEWS.map((view) => (
          <Button
            key={view.key}
            type="button"
            size="sm"
            variant="secondary"
            onClick={() => applyView(view)}
          >
            {view.label}
          </Button>
        ))}
      </div>

      <div className="mb-2 flex flex-wrap gap-2" aria-label="Filter by source">
        {ALL_SOURCES.map((s) => {
          const pressed = !allSourcesActive && sources.has(s)
          return (
            <Button
              key={s}
              type="button"
              size="sm"
              variant={pressed ? 'primary' : 'secondary'}
              aria-pressed={pressed}
              onClick={() => toggleSource(s)}
            >
              {SOURCE_LABEL[s]}
            </Button>
          )
        })}
      </div>

      <div className="mb-2 flex flex-wrap gap-2" aria-label="Filter by status">
        {ALL_STATUSES.map((s) => {
          const pressed = statuses.has(s)
          return (
            <Button
              key={s}
              type="button"
              size="sm"
              variant={pressed ? 'primary' : 'secondary'}
              aria-pressed={pressed}
              onClick={() => toggleStatus(s)}
            >
              {STATUS_LABEL[s]}
            </Button>
          )
        })}
      </div>

      <div className="mb-3">
        <Input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search across item details…"
          aria-label="Search inbox items"
        />
      </div>

      {error ? <p className="text-sm text-destructive">{error}</p> : null}

      {pendingVisible.length > 1 && (
        <div className="mb-3 flex items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant="secondary"
            disabled={bulkBusy}
            onClick={() => void bulkDismiss()}
          >
            {bulkBusy ? 'Dismissing…' : `Dismiss all ${pendingVisible.length} pending`}
          </Button>
        </div>
      )}

      {loading ? (
        <p className="muted">Loading…</p>
      ) : visible.length === 0 ? (
        <EmptyState
          title="No items"
          description="Nothing matches the current filters. Try a different source, status, or clear the search."
        />
      ) : (
        <ul className="grid gap-2 p-0" style={{ listStyle: 'none' }}>
          {visible.map((item) => (
            <ReviewItemCard
              key={item.id}
              item={item}
              busy={bulkBusy || busyId === item.id}
              onAction={(it, kind) => void onAction(it, kind)}
            />
          ))}
        </ul>
      )}
    </div>
  )
}
