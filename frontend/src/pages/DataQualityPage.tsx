/**
 * Data-quality dashboard (#234) — surfaces the overall finance-dataset
 * quality score and the per-component breakdown with click-through links to
 * the cleanup workflows.
 *
 * Reads from GET /api/data-quality. The endpoint bundles `actionLinks` so
 * the cards' labels + URLs come from the backend, keeping this component a
 * thin renderer (one place to update copy / routes).
 */
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  AlertCircle,
  ArrowRight,
  BookOpenCheck,
  CheckCircle2,
  ClipboardCheck,
  Copy,
  Files,
  ReceiptText,
  RefreshCw,
  Repeat,
  Tag,
} from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { PageHeader } from '@/components/ui/page-header'
import { Alert } from '@/components/ui/alert'
import { getJson } from '../lib/api'

type ComponentKey =
  | 'categorization'
  | 'rules'
  | 'receipts'
  | 'duplicates'
  | 'transfers'
  | 'subscriptions'
  | 'review'

type ActionLink = {
  key: ComponentKey
  label: string
  href: string
  description: string
}

type CoverageComponent = {
  totalSpend: number
  coverage: number
}

type DataQualityResponse = {
  score: number
  componentScores: Record<ComponentKey, number>
  components: {
    categorization: CoverageComponent & { categorized: number; uncategorized: number }
    rules: CoverageComponent & { ruleCovered: number; uncovered: number }
    receipts: CoverageComponent & { withReceipt: number; missing: number }
    duplicates: { duplicateGroups: number; duplicateTransactions: number }
    transfers: { unmatched: number }
    subscriptions: { stale: number }
    review: { backlog: number }
  }
  totals: { transactionsScanned: number; spendTransactions: number }
  actionLinks: ActionLink[]
}

/**
 * Per-component icon. Kept as a static lookup table because tailwind/JIT
 * needs literal class names and the same goes for static React components
 * referenced from a dynamic key.
 */
const COMPONENT_ICON: Record<ComponentKey, typeof Tag> = {
  categorization: Tag,
  rules: BookOpenCheck,
  receipts: ReceiptText,
  duplicates: Copy,
  transfers: Repeat,
  subscriptions: RefreshCw,
  review: ClipboardCheck,
}

const COMPONENT_ORDER: ComponentKey[] = [
  'categorization',
  'rules',
  'receipts',
  'duplicates',
  'transfers',
  'subscriptions',
  'review',
]

function formatPercent(n: number): string {
  return `${Math.round(n * 100)}%`
}

/**
 * Resolve a tone class for the per-component card based on its 0..1 score.
 * Lookup table over discrete buckets so Tailwind JIT picks up the literals.
 */
function toneClass(score: number): string {
  if (score >= 0.85) return 'border-emerald-500/40 bg-emerald-50 dark:bg-emerald-900/20'
  if (score >= 0.6) return 'border-amber-500/40 bg-amber-50 dark:bg-amber-900/20'
  return 'border-rose-500/40 bg-rose-50 dark:bg-rose-900/20'
}

function scoreTextClass(score: number): string {
  if (score >= 0.85) return 'text-emerald-700 dark:text-emerald-300'
  if (score >= 0.6) return 'text-amber-700 dark:text-amber-300'
  return 'text-rose-700 dark:text-rose-300'
}

/**
 * Render the count / coverage subtitle under the card label, varying by
 * component type. For coverage cards we surface "N / M (P%)"; for
 * issue-count cards we surface "N flagged".
 */
function renderCardDetail(
  key: ComponentKey,
  components: DataQualityResponse['components'],
): string {
  switch (key) {
    case 'categorization': {
      const c = components.categorization
      if (c.totalSpend === 0) return 'No spend yet'
      return `${c.categorized} of ${c.totalSpend} (${formatPercent(c.coverage)})`
    }
    case 'rules': {
      const c = components.rules
      if (c.totalSpend === 0) return 'No spend yet'
      return `${c.ruleCovered} of ${c.totalSpend} (${formatPercent(c.coverage)})`
    }
    case 'receipts': {
      const c = components.receipts
      if (c.totalSpend === 0) return 'No spend yet'
      return `${c.withReceipt} of ${c.totalSpend} (${formatPercent(c.coverage)})`
    }
    case 'duplicates': {
      const c = components.duplicates
      if (c.duplicateGroups === 0) return 'No duplicates detected'
      return `${c.duplicateGroups} group${c.duplicateGroups === 1 ? '' : 's'} (${c.duplicateTransactions} rows)`
    }
    case 'transfers':
      return components.transfers.unmatched === 0
        ? 'All transfers paired'
        : `${components.transfers.unmatched} unmatched`
    case 'subscriptions':
      return components.subscriptions.stale === 0
        ? 'No stale subscriptions'
        : `${components.subscriptions.stale} pending classification`
    case 'review':
      return components.review.backlog === 0
        ? 'Backlog clear'
        : `${components.review.backlog} flagged for review`
  }
}

export function DataQualityPage() {
  const [data, setData] = useState<DataQualityResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    getJson<DataQualityResponse>('/api/data-quality')
      .then((res) => {
        if (cancelled) return
        setData(res)
        setLoading(false)
      })
      .catch((e: unknown) => {
        if (cancelled) return
        setError(e instanceof Error ? e.message : 'Failed to load data quality')
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  if (loading) {
    return (
      <main>
        <PageHeader
          title="Data quality"
          description="Score for the completeness and trustworthiness of your finance dataset."
        />
        <p className="muted">Loading…</p>
      </main>
    )
  }

  if (error) {
    return (
      <main>
        <PageHeader
          title="Data quality"
          description="Score for the completeness and trustworthiness of your finance dataset."
        />
        <Alert variant="error">
          <span className="inline-flex items-center gap-2">
            <AlertCircle size={16} aria-hidden="true" /> {error}
          </span>
        </Alert>
      </main>
    )
  }

  if (!data) return null

  // Empty-state: brand-new account, no transactions scanned. AC asks for a
  // useful empty state — explain what the dashboard will show once data
  // arrives instead of showing a misleading 100% score with no context.
  if (data.totals.transactionsScanned === 0) {
    return (
      <main>
        <PageHeader
          title="Data quality"
          description="Score for the completeness and trustworthiness of your finance dataset."
        />
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-8 text-center">
            <Files size={32} className="text-muted-foreground" aria-hidden="true" />
            <h2 className="text-lg font-semibold">No transactions yet</h2>
            <p className="muted max-w-md">
              Once you import or capture transactions, this page tracks
              categorization, rule coverage, receipt completeness, duplicates,
              transfers, subscriptions, and your review backlog — and links
              you to the cleanup workflows that fix each gap.
            </p>
            <Link to="/import" className="inline-flex items-center gap-1 text-sm font-medium underline">
              Import transactions <ArrowRight size={14} aria-hidden="true" />
            </Link>
          </CardContent>
        </Card>
      </main>
    )
  }

  const overallPct = formatPercent(data.score)
  const linkByKey = new Map<ComponentKey, ActionLink>()
  for (const link of data.actionLinks) linkByKey.set(link.key, link)

  return (
    <main>
      <PageHeader
        title="Data quality"
        description="Score for the completeness and trustworthiness of your finance dataset."
      />

      <Card className={`mb-4 ${toneClass(data.score)}`} aria-labelledby="dq-overall-score">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <div className="text-sm uppercase tracking-wide text-muted-foreground">
              Overall score
            </div>
            <div
              id="dq-overall-score"
              className={`text-4xl font-bold ${scoreTextClass(data.score)}`}
            >
              {overallPct}
            </div>
            <p className="muted mb-0 mt-1">
              Equal-weight average of the seven components below.
              {data.score >= 0.85 ? (
                <span className="ml-1 inline-flex items-center gap-1 text-emerald-700 dark:text-emerald-300">
                  <CheckCircle2 size={14} aria-hidden="true" /> Looking healthy.
                </span>
              ) : null}
            </p>
          </div>
          <div className="text-right text-sm text-muted-foreground">
            <div>Transactions scanned: {data.totals.transactionsScanned.toLocaleString()}</div>
            <div>Spend transactions: {data.totals.spendTransactions.toLocaleString()}</div>
          </div>
        </div>
      </Card>

      <div
        className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3"
        role="list"
        aria-label="Data quality components"
      >
        {COMPONENT_ORDER.map((key) => {
          const score = data.componentScores[key]
          const link = linkByKey.get(key)
          const Icon = COMPONENT_ICON[key]
          const detail = renderCardDetail(key, data.components)
          const tone = toneClass(score)
          const heading = link?.label ?? key
          const description = link?.description ?? ''

          const content = (
            <Card className={`h-full ${tone}`} role="listitem">
              <div className="flex items-start gap-3">
                <Icon size={20} className="mt-1 shrink-0" aria-hidden="true" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline justify-between gap-2">
                    <h3 className="text-base font-semibold">{heading}</h3>
                    <span className={`text-sm font-semibold ${scoreTextClass(score)}`}>
                      {formatPercent(score)}
                    </span>
                  </div>
                  <p className="muted mt-1 mb-0 text-sm">{detail}</p>
                  {description ? (
                    <p className="muted mt-2 mb-0 text-xs">{description}</p>
                  ) : null}
                </div>
              </div>
            </Card>
          )

          if (!link) return <div key={key}>{content}</div>
          return (
            <Link
              key={key}
              to={link.href}
              className="block no-underline focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              aria-label={`${link.label}: ${detail}`}
            >
              {content}
            </Link>
          )
        })}
      </div>
    </main>
  )
}
