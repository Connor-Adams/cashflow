/**
 * Unified AI inbox page (issue #378).
 *
 * Fans out to GET /api/review-items and renders items from four sources:
 *   - AI suggestions       (/api/ai/…)
 *   - AI review runs       (/api/ai/reviews/…)
 *   - CFO briefings        (/api/cfo/briefings/…)
 *   - Chat proposals       (/api/chat/proposals/…)
 *
 * Write paths call the existing per-source endpoints — this page does NOT
 * introduce any new write API.
 */
import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card } from '@/components/ui/card'
import { PageHeader } from '@/components/ui/page-header'
import { SeverityBadge, type InsightSeverity } from '@/components/ai/SeverityBadge'
import { getJson, postJson } from '@/lib/api'
import { useToast } from '@/components/ui/toast'

// ---------------------------------------------------------------------------
// Types (mirror backend ReviewItem shape)
// ---------------------------------------------------------------------------

type CommonStatus = 'pending' | 'resolved' | 'dismissed' | 'expired'

type ReviewItemSource =
  | 'ai-suggestion'
  | 'ai-review'
  | 'cfo-briefing'
  | 'chat-proposal'

type SubjectType =
  | 'transaction'
  | 'receipt'
  | 'rule'
  | 'event'
  | 'subscription'
  | 'import'
  | 'chat-message'
  | null

interface ReviewItem {
  id: string
  source: ReviewItemSource
  subjectType: SubjectType
  subjectId: string | null
  payload: Record<string, unknown>
  statusCommon: CommonStatus
  nativeStatus: string
  createdAt: string
  resolvedAt: string | null
}

type ListResponse = { data: ReviewItem[]; total: number }

// ---------------------------------------------------------------------------
// Filter definitions
// ---------------------------------------------------------------------------

const SOURCE_LABELS: Record<ReviewItemSource, string> = {
  'ai-suggestion': 'AI suggestions',
  'ai-review': 'Review queue',
  'cfo-briefing': 'CFO briefings',
  'chat-proposal': 'Chat proposals',
}

const STATUS_LABELS: Record<CommonStatus, string> = {
  pending: 'Pending',
  resolved: 'Resolved',
  dismissed: 'Dismissed',
  expired: 'Expired',
}

// Saved view tabs — each is a preset of status + source filters.
type SavedView =
  | 'ai-suggestions'
  | 'review-queue'
  | 'cfo-briefings'
  | 'chat-proposals'
  | 'all-resolved'
  | 'custom'

interface SavedViewConfig {
  label: string
  statuses: CommonStatus[]
  sources: ReviewItemSource[]
}

const SAVED_VIEWS: Record<Exclude<SavedView, 'custom'>, SavedViewConfig> = {
  'ai-suggestions': {
    label: 'AI suggestions',
    statuses: ['pending'],
    sources: ['ai-suggestion'],
  },
  'review-queue': {
    label: 'Review queue',
    statuses: ['pending'],
    sources: ['ai-review'],
  },
  'cfo-briefings': {
    label: 'CFO briefings',
    statuses: ['pending'],
    sources: ['cfo-briefing'],
  },
  'chat-proposals': {
    label: 'Chat proposals',
    statuses: ['pending'],
    sources: ['chat-proposal'],
  },
  'all-resolved': {
    label: 'All resolved',
    statuses: ['resolved'],
    sources: ['ai-suggestion', 'ai-review', 'cfo-briefing', 'chat-proposal'],
  },
}

const ALL_SOURCES: ReviewItemSource[] = [
  'ai-suggestion',
  'ai-review',
  'cfo-briefing',
  'chat-proposal',
]

const ALL_STATUSES: CommonStatus[] = ['pending', 'resolved', 'dismissed', 'expired']

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    })
  } catch {
    return iso.slice(0, 10)
  }
}

function getItemTitle(item: ReviewItem): string {
  const p = item.payload
  if (typeof p.title === 'string') return p.title
  if (typeof p.kind === 'string') return p.kind.replace(/_/g, ' ')
  return item.source.replace(/-/g, ' ')
}

function getItemSummary(item: ReviewItem): string {
  const p = item.payload
  if (typeof p.summary === 'string') return p.summary
  if (typeof p.output === 'object' && p.output !== null) return '[AI output attached]'
  return ''
}

function getItemSeverity(item: ReviewItem): InsightSeverity | null {
  const s = item.payload.severity
  if (s === 'action' || s === 'watch' || s === 'info') return s
  return null
}

/**
 * Build the native write endpoint path for each source, used by action
 * buttons. Write paths stay at existing per-source endpoints.
 */
function resolveWriteEndpoint(item: ReviewItem, action: string): string | null {
  const p = item.payload
  switch (item.source) {
    case 'ai-suggestion':
      // /api/ai/inbox/:id/reject  (existing)
      return `/api/ai/inbox/${item.id.split(':')[1]}/${action}`
    case 'ai-review': {
      const runId = p.runId
      const itemId = p.itemId
      if (action === 'accept') return `/api/ai/reviews/${runId}/items/${itemId}/accept`
      if (action === 'dismiss') return `/api/ai/reviews/${runId}/items/${itemId}/dismiss`
      return null
    }
    case 'cfo-briefing': {
      const runId = p.runId
      const itemId = p.itemId
      if (action === 'resolve') return `/api/cfo/briefings/${runId}/items/${itemId}/resolve`
      if (action === 'dismiss') return `/api/cfo/briefings/${runId}/items/${itemId}/dismiss`
      return null
    }
    case 'chat-proposal':
      return null // proposals are applied from the chat page
    default:
      return null
  }
}

// ---------------------------------------------------------------------------
// Card components per source
// ---------------------------------------------------------------------------

interface ItemCardProps {
  item: ReviewItem
  onAction: (item: ReviewItem, action: string) => Promise<void>
  acting: boolean
}

function AiSuggestionCard({ item, onAction, acting }: ItemCardProps) {
  const title = getItemTitle(item)
  const summary = getItemSummary(item)
  const p = item.payload
  return (
    <Card className="p-4 flex flex-col gap-2">
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="font-medium text-sm">{title}</p>
          {summary && <p className="text-xs text-muted-foreground mt-0.5">{summary}</p>}
        </div>
        <Badge variant="outline" className="shrink-0 text-xs">
          AI suggestion
        </Badge>
      </div>
      {typeof p.kind === 'string' && (
        <p className="text-xs text-muted-foreground">Kind: {p.kind}</p>
      )}
      <p className="text-xs text-muted-foreground">{formatDate(item.createdAt)}</p>
      {item.statusCommon === 'pending' && (
        <div className="flex gap-2 mt-1">
          <Button
            size="sm"
            variant="secondary"
            disabled={acting}
            onClick={() => void onAction(item, 'reject')}
          >
            Dismiss
          </Button>
        </div>
      )}
    </Card>
  )
}

function AiReviewCard({ item, onAction, acting }: ItemCardProps) {
  const p = item.payload
  const severity = getItemSeverity(item)
  const title = typeof p.title === 'string' ? p.title : 'Review item'
  const summary = typeof p.summary === 'string' ? p.summary : ''
  const runId = p.runId
  return (
    <Card className="p-4 flex flex-col gap-2">
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="font-medium text-sm">{title}</p>
          {summary && <p className="text-xs text-muted-foreground mt-0.5">{summary}</p>}
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {severity && <SeverityBadge severity={severity} />}
          <Badge variant="outline" className="text-xs">Review</Badge>
        </div>
      </div>
      {typeof p.type === 'string' && (
        <p className="text-xs text-muted-foreground">Type: {p.type}</p>
      )}
      {typeof p.periodStart === 'string' && (
        <p className="text-xs text-muted-foreground">
          Period: {p.periodStart} – {p.periodEnd as string}
        </p>
      )}
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">{formatDate(item.createdAt)}</p>
        <Link
          to={`/ai/reviews`}
          className="text-xs underline text-muted-foreground hover:text-foreground"
        >
          View run #{runId as number}
        </Link>
      </div>
      {item.statusCommon === 'pending' && (
        <div className="flex gap-2 mt-1">
          <Button
            size="sm"
            disabled={acting}
            onClick={() => void onAction(item, 'accept')}
          >
            Accept
          </Button>
          <Button
            size="sm"
            variant="secondary"
            disabled={acting}
            onClick={() => void onAction(item, 'dismiss')}
          >
            Dismiss
          </Button>
        </div>
      )}
    </Card>
  )
}

function CfoBriefingCard({ item, onAction, acting }: ItemCardProps) {
  const p = item.payload
  const severity = getItemSeverity(item)
  const title = typeof p.title === 'string' ? p.title : 'Briefing item'
  const summary = typeof p.summary === 'string' ? p.summary : ''
  const link = typeof p.link === 'string' ? p.link : null
  return (
    <Card className="p-4 flex flex-col gap-2">
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="font-medium text-sm">{title}</p>
          {summary && <p className="text-xs text-muted-foreground mt-0.5">{summary}</p>}
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {severity && <SeverityBadge severity={severity} />}
          <Badge variant="outline" className="text-xs">CFO</Badge>
        </div>
      </div>
      {typeof p.type === 'string' && (
        <p className="text-xs text-muted-foreground">Type: {p.type}</p>
      )}
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">{formatDate(item.createdAt)}</p>
        {link ? (
          <Link
            to={link}
            className="text-xs underline text-muted-foreground hover:text-foreground"
          >
            View details
          </Link>
        ) : (
          <Link
            to="/cfo/briefings"
            className="text-xs underline text-muted-foreground hover:text-foreground"
          >
            View briefings
          </Link>
        )}
      </div>
      {item.statusCommon === 'pending' && (
        <div className="flex gap-2 mt-1">
          <Button
            size="sm"
            disabled={acting}
            onClick={() => void onAction(item, 'resolve')}
          >
            Resolve
          </Button>
          <Button
            size="sm"
            variant="secondary"
            disabled={acting}
            onClick={() => void onAction(item, 'dismiss')}
          >
            Dismiss
          </Button>
        </div>
      )}
    </Card>
  )
}

function ChatProposalCard({ item }: ItemCardProps) {
  const p = item.payload
  const kind = typeof p.kind === 'string' ? p.kind : 'proposal'
  const threadId = p.threadId
  return (
    <Card className="p-4 flex flex-col gap-2">
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="font-medium text-sm capitalize">{kind.replace(/_/g, ' ')}</p>
          {p.preview && (
            <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">
              {JSON.stringify(p.preview).slice(0, 120)}
            </p>
          )}
        </div>
        <Badge variant="outline" className="shrink-0 text-xs">Chat</Badge>
      </div>
      {typeof p.expiresAt === 'string' && (
        <p className="text-xs text-muted-foreground">
          Expires: {formatDate(p.expiresAt)}
        </p>
      )}
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">{formatDate(item.createdAt)}</p>
        <Link
          to="/chat"
          state={{ threadId }}
          className="text-xs underline text-muted-foreground hover:text-foreground"
        >
          Open chat
        </Link>
      </div>
      {item.statusCommon === 'pending' && (
        <p className="text-xs text-muted-foreground italic">
          Apply or reject from the chat page.
        </p>
      )}
    </Card>
  )
}

function ReviewItemCard(props: ItemCardProps) {
  switch (props.item.source) {
    case 'ai-suggestion':
      return <AiSuggestionCard {...props} />
    case 'ai-review':
      return <AiReviewCard {...props} />
    case 'cfo-briefing':
      return <CfoBriefingCard {...props} />
    case 'chat-proposal':
      return <ChatProposalCard {...props} />
  }
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function AiUnifiedInboxPage() {
  const [items, setItems] = useState<ReviewItem[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [acting, setActing] = useState(false)

  // Filter state
  const [activeStatuses, setActiveStatuses] = useState<CommonStatus[]>(['pending'])
  const [activeSources, setActiveSources] = useState<ReviewItemSource[]>(ALL_SOURCES)
  const [activeView, setActiveView] = useState<SavedView>('custom')

  const { showToast } = useToast()

  const load = useCallback(async () => {
    setLoading(true)
    setErr(null)
    try {
      const qs = new URLSearchParams({
        status: activeStatuses.join(','),
        source: activeSources.join(','),
        limit: '200',
      })
      const data = await getJson<ListResponse>(`/api/review-items?${qs.toString()}`)
      setItems(data.data)
      setTotal(data.total)
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not load review items')
    } finally {
      setLoading(false)
    }
  }, [activeStatuses, activeSources])

  useEffect(() => {
    void load()
  }, [load])

  function applyView(view: Exclude<SavedView, 'custom'>) {
    const cfg = SAVED_VIEWS[view]
    setActiveStatuses(cfg.statuses)
    setActiveSources(cfg.sources)
    setActiveView(view)
  }

  function toggleStatus(status: CommonStatus) {
    setActiveStatuses((prev) => {
      const next = prev.includes(status)
        ? prev.filter((s) => s !== status)
        : [...prev, status]
      return next.length > 0 ? next : prev
    })
    setActiveView('custom')
  }

  function toggleSource(source: ReviewItemSource) {
    setActiveSources((prev) => {
      const next = prev.includes(source)
        ? prev.filter((s) => s !== source)
        : [...prev, source]
      return next.length > 0 ? next : prev
    })
    setActiveView('custom')
  }

  const handleAction = useCallback(
    async (item: ReviewItem, action: string) => {
      const endpoint = resolveWriteEndpoint(item, action)
      if (!endpoint) return
      setActing(true)
      try {
        await postJson(endpoint, {})
        showToast({ title: `Item ${action}ed`, variant: 'success', durationMs: 3000 })
        await load()
      } catch (e) {
        showToast({
          title: 'Action failed',
          description: e instanceof Error ? e.message : 'Unknown error',
          durationMs: 5000,
        })
      } finally {
        setActing(false)
      }
    },
    [load, showToast],
  )

  const savedViewKeys = Object.keys(SAVED_VIEWS) as Exclude<SavedView, 'custom'>[]

  return (
    <div className="page">
      <PageHeader
        title="AI Inbox"
        description="Unified view of AI suggestions, review items, CFO briefings, and chat proposals."
        actions={
          <Button
            type="button"
            variant="secondary"
            onClick={() => void load()}
            disabled={loading}
          >
            <RefreshCw aria-hidden="true" />
            Refresh
          </Button>
        }
      />

      {/* Saved view tabs */}
      <div className="flex flex-wrap gap-2 mb-4">
        {savedViewKeys.map((view) => {
          const isActive = activeView === view
          return (
            <button
              key={view}
              type="button"
              onClick={() => applyView(view)}
              className={
                isActive
                  ? 'rounded-full border border-foreground bg-foreground px-3 py-1 text-xs font-semibold text-background'
                  : 'rounded-full border border-border bg-background px-3 py-1 text-xs font-medium text-muted-foreground hover:text-foreground'
              }
              aria-pressed={isActive}
            >
              {SAVED_VIEWS[view].label}
            </button>
          )
        })}
      </div>

      {/* Filter chips */}
      <div className="flex flex-wrap gap-4 mb-4">
        <div className="flex flex-col gap-1">
          <span className="text-xs font-semibold text-muted-foreground">Source</span>
          <div className="flex flex-wrap gap-1.5">
            {ALL_SOURCES.map((source) => {
              const active = activeSources.includes(source)
              return (
                <button
                  key={source}
                  type="button"
                  onClick={() => toggleSource(source)}
                  aria-pressed={active}
                  className={
                    active
                      ? 'rounded-full border border-foreground bg-foreground px-2.5 py-0.5 text-xs font-semibold text-background'
                      : 'rounded-full border border-border bg-background px-2.5 py-0.5 text-xs font-medium text-muted-foreground hover:text-foreground'
                  }
                >
                  {SOURCE_LABELS[source]}
                </button>
              )
            })}
          </div>
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-xs font-semibold text-muted-foreground">Status</span>
          <div className="flex flex-wrap gap-1.5">
            {ALL_STATUSES.map((status) => {
              const active = activeStatuses.includes(status)
              return (
                <button
                  key={status}
                  type="button"
                  onClick={() => toggleStatus(status)}
                  aria-pressed={active}
                  className={
                    active
                      ? 'rounded-full border border-foreground bg-foreground px-2.5 py-0.5 text-xs font-semibold text-background'
                      : 'rounded-full border border-border bg-background px-2.5 py-0.5 text-xs font-medium text-muted-foreground hover:text-foreground'
                  }
                >
                  {STATUS_LABELS[status]}
                </button>
              )
            })}
          </div>
        </div>
      </div>

      {/* Results summary */}
      <p className="text-sm text-muted-foreground mb-4">
        {loading ? 'Loading…' : `${items.length} of ${total} item(s)`}
      </p>

      {err && <p className="text-sm text-destructive mb-4">{err}</p>}

      {/* Item grid */}
      {!loading && items.length === 0 && !err && (
        <div className="rounded-lg border border-border p-8 text-center">
          <p className="text-muted-foreground text-sm">No items match the current filters.</p>
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {items.map((item) => (
          <ReviewItemCard
            key={item.id}
            item={item}
            onAction={handleAction}
            acting={acting}
          />
        ))}
      </div>
    </div>
  )
}
