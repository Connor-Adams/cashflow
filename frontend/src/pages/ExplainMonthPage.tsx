import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  AlertTriangle,
  Briefcase,
  ClipboardCheck,
  Receipt,
  Sparkles,
  TrendingDown,
  TrendingUp,
} from 'lucide-react'
import { Alert } from '@cashflow/ui'
import { Badge } from '@cashflow/ui'
import { Button } from '@cashflow/ui'
import { Card } from '@cashflow/ui'
import { EmptyState } from '@cashflow/ui'
import { Grid } from '@cashflow/ui'
import { NativeSelect } from '@cashflow/ui'
import { PageHeader } from '@/components/ui/page-header'
import { SectionHeader } from '@/components/ui/section-header'
import { getJson } from '../lib/api'
import { formatMoney } from '../lib/formatMoney'
import type {
  ExplainMonthFinding,
  ExplainMonthFindingKind,
  ExplainMonthResponse,
  ExplainMonthSeverity,
  ExplainMonthTransactionFilter,
} from '../types/api'

/**
 * ExplainMonthPage — renders the "explain this month" narrative report
 * (Cashflow #225). Pulls a deterministic month-over-month breakdown plus a
 * grouped list of findings from /api/reports/explain-month and lets the
 * user pivot into the TransactionsPage with the same filters applied.
 *
 * The AI summary is opt-in via a checkbox. When opted-in the backend will
 * try to fetch a narrative from OpenAI; when OPENAI_API_KEY is unset the
 * route returns aiSummary=null and we render a static "AI summary
 * unavailable" hint. The deterministic report is always present.
 */

/** Card classes expanded onto <section> when the semantic element needs
 *  aria attributes that can't be forwarded through <Card> (a plain div). */
const CARD_CLS =
  'rounded-lg border border-border bg-card p-4 text-card-foreground shadow-sm sm:p-5 mb-4'

/** Tailwind variant lookup for severity badges. JIT needs literal classes,
 *  so we keep the map explicit. */
const SEVERITY_BADGE: Record<
  ExplainMonthSeverity,
  'default' | 'secondary' | 'outline' | 'destructive'
> = {
  high: 'destructive',
  medium: 'default',
  low: 'secondary',
}

const KIND_LABEL: Record<ExplainMonthFindingKind, string> = {
  spend_change: 'Top spend changes',
  subscription_change: 'Subscription changes',
  missing_receipt: 'Missing receipts',
  review_needed: 'Needs review',
  business_summary: 'Business spend',
}

const KIND_ICON: Record<ExplainMonthFindingKind, typeof TrendingUp> = {
  spend_change: TrendingUp,
  subscription_change: AlertTriangle,
  missing_receipt: Receipt,
  review_needed: ClipboardCheck,
  business_summary: Briefcase,
}

const KIND_ORDER: ExplainMonthFindingKind[] = [
  'spend_change',
  'subscription_change',
  'missing_receipt',
  'review_needed',
  'business_summary',
]

/** Default month is the current calendar month in the browser's local
 *  timezone. The backend treats `YYYY-MM` as a pure label — there is no
 *  timezone math on either side — so this matches user intuition. */
function defaultMonth(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

/** Translate the API's transactionFilter into a URLSearchParams compatible
 *  with TransactionsPage. We only forward fields the TransactionsPage
 *  natively understands — fields like `merchant` or `businessOnly` would
 *  be ignored upstream so we drop them rather than mislead the user. */
function buildTransactionsHref(filter: ExplainMonthTransactionFilter): string {
  const params = new URLSearchParams()
  if (filter.dateFrom) params.set('dateFrom', filter.dateFrom)
  if (filter.dateTo) params.set('dateTo', filter.dateTo)
  if (filter.category) params.set('category', filter.category)
  if (filter.currency) params.set('currency', filter.currency)
  if (filter.reviewFlag) params.set('reviewFlag', 'true')
  const query = params.toString()
  return query ? `/transactions?${query}` : '/transactions'
}

export function ExplainMonthPage() {
  const [month, setMonth] = useState<string>(defaultMonth())
  const [currency, setCurrency] = useState<string>('')
  const [aiOptIn, setAiOptIn] = useState<boolean>(false)
  const [data, setData] = useState<ExplainMonthResponse | null>(null)
  const [loading, setLoading] = useState<boolean>(true)
  const [err, setErr] = useState<string | null>(null)

  const queryString = useMemo(() => {
    const params = new URLSearchParams()
    params.set('month', month)
    if (currency) params.set('currency', currency)
    if (aiOptIn) params.set('ai', 'true')
    return params.toString()
  }, [month, currency, aiOptIn])

  const load = useCallback(async () => {
    setLoading(true)
    setErr(null)
    try {
      const res = await getJson<ExplainMonthResponse>(
        `/api/reports/explain-month?${queryString}`,
      )
      setData(res)
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Error')
    } finally {
      setLoading(false)
    }
  }, [queryString])

  useEffect(() => {
    void load()
  }, [load])

  const findingsByKind = useMemo(() => {
    const map = new Map<ExplainMonthFindingKind, ExplainMonthFinding[]>()
    for (const f of data?.findings ?? []) {
      const list = map.get(f.kind) ?? []
      list.push(f)
      map.set(f.kind, list)
    }
    return map
  }, [data])

  const availableCurrencies = useMemo(() => {
    const set = new Set<string>()
    for (const m of data?.monthOverMonth ?? []) set.add(m.currency)
    for (const f of data?.findings ?? []) set.add(f.currency)
    return Array.from(set).sort()
  }, [data])

  return (
    <div className="page">
      <PageHeader
        title="Explain this month"
        description="A deterministic look at what changed, what drove spend, and what needs attention. Click any finding to jump to the matching transactions."
      />

      {/* Controls card — no aria semantics needed on the container */}
      <Card className="mb-4">
        <div className="flex gap-3 items-end flex-wrap">
          <div className="flex flex-col gap-1">
            <label htmlFor="explain-month-month">Month</label>
            <input
              id="explain-month-month"
              type="month"
              value={month}
              onChange={(e) => setMonth(e.target.value)}
              className="input min-w-40"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="explain-month-currency">Currency</label>
            <NativeSelect
              id="explain-month-currency"
              value={currency}
              onChange={(e) => setCurrency(e.target.value)}
            >
              <option value="">All currencies</option>
              {availableCurrencies.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </NativeSelect>
          </div>
          <label className="flex items-center gap-1.5 cursor-pointer">
            <input
              type="checkbox"
              checked={aiOptIn}
              onChange={(e) => setAiOptIn(e.target.checked)}
            />
            <span>Add AI summary</span>
          </label>
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              void load()
            }}
            disabled={loading}
          >
            Refresh
          </Button>
        </div>
      </Card>

      {/* Error: .error was inline-flex danger-colored badge. Alert variant="error"
          provides role=alert + equivalent danger surface. */}
      {err && (
        <Alert variant="error" className="mb-4">
          {err}
        </Alert>
      )}

      {loading && !data ? (
        /* aria-busy on the container requires <section>; expand Card classes */
        <section className={CARD_CLS} aria-busy="true">
          <p className="text-sm leading-6 text-muted-foreground mb-0">
            Building the report…
          </p>
        </section>
      ) : !data ? null : (
        <>
          {data.aiSummary != null && (
            /* aria-label on container — expand Card classes onto <section> */
            <section className={CARD_CLS} aria-label="AI summary">
              <div className="flex gap-2 items-start">
                <Sparkles size={18} aria-hidden="true" />
                <p className="m-0">{data.aiSummary}</p>
              </div>
            </section>
          )}
          {aiOptIn && data.aiSummary == null && (
            <Card className="mb-4">
              <p className="text-sm leading-6 text-muted-foreground mb-0">
                AI summary unavailable — OPENAI_API_KEY is not configured on the
                server. The rest of the report below is deterministic and does
                not require AI.
              </p>
            </Card>
          )}

          <MonthOverMonthSection data={data} />

          {(data.findings ?? []).length === 0 ? (
            <EmptyState
              className="mb-4"
              title="Nothing notable this month"
              description="Spend matched the previous month, no subscriptions changed, and nothing needs review."
              actions={
                <Button asChild size="sm">
                  <Link to="/transactions">View transactions</Link>
                </Button>
              }
            />
          ) : (
            KIND_ORDER.filter((k) => findingsByKind.has(k)).map((kind) => (
              <FindingGroup
                key={kind}
                kind={kind}
                items={findingsByKind.get(kind) ?? []}
              />
            ))
          )}
        </>
      )}
    </div>
  )
}

function MonthOverMonthSection({ data }: { data: ExplainMonthResponse }) {
  if (data.monthOverMonth.length === 0) return null
  return (
    /* aria-label on the section — expand Card classes */
    <section
      className={CARD_CLS}
      aria-label="Month over month totals"
    >
      {/* SectionHeader: title-only shape (no actions) — fits the primitive */}
      <SectionHeader title={`${data.month} vs ${data.previousMonth}`} className="mb-3" />

      {/* Grid: replaces repeat(auto-fit, minmax(220px, 1fr)) gap:12 */}
      <Grid minItemWidth={220} gap="md">
        {data.monthOverMonth.map((mom) => {
          const spendUp = mom.spendDelta > 0
          const trendIcon = spendUp ? (
            <TrendingUp size={16} aria-hidden="true" />
          ) : (
            <TrendingDown size={16} aria-hidden="true" />
          )
          return (
            /*
             * StatCard not used here: each tile shows THREE metrics (Spend / Income / Net)
             * each with inline current+delta. StatCard is designed for a single
             * label+value+delta — it cannot cleanly represent a 3-row <dl>.
             * Decision: keep the <dl> tile with token utilities. The box is already
             * converted to border/rounded/padding token classes in step 1.
             */
            <div
              key={mom.currency}
              className="border border-border rounded-md p-3"
            >
              <div className="flex justify-between items-center">
                <strong>{mom.currency}</strong>
                {trendIcon}
              </div>
              {/* .muted has mb-4 which breaks dl grid rows; override to mb-0 per-term */}
              <dl className="mt-2 grid grid-cols-[auto_1fr] gap-y-1 gap-x-2">
                <dt className="text-sm leading-6 text-muted-foreground mb-0">Spend</dt>
                <dd className="m-0 text-right">
                  {formatMoney(mom.currentSpend, mom.currency)}{' '}
                  <span className="text-sm leading-6 text-muted-foreground">
                    ({mom.spendDelta >= 0 ? '+' : ''}
                    {formatMoney(mom.spendDelta, mom.currency)})
                  </span>
                </dd>
                <dt className="text-sm leading-6 text-muted-foreground mb-0">Income</dt>
                <dd className="m-0 text-right">
                  {formatMoney(mom.currentIncome, mom.currency)}{' '}
                  <span className="text-sm leading-6 text-muted-foreground">
                    ({mom.incomeDelta >= 0 ? '+' : ''}
                    {formatMoney(mom.incomeDelta, mom.currency)})
                  </span>
                </dd>
                <dt className="text-sm leading-6 text-muted-foreground mb-0">Net</dt>
                <dd className="m-0 text-right">
                  {formatMoney(mom.netCurrent, mom.currency)}{' '}
                  <span className="text-sm leading-6 text-muted-foreground">
                    ({mom.netDelta >= 0 ? '+' : ''}
                    {formatMoney(mom.netDelta, mom.currency)})
                  </span>
                </dd>
              </dl>
            </div>
          )
        })}
      </Grid>
    </section>
  )
}

function FindingGroup({
  kind,
  items,
}: {
  kind: ExplainMonthFindingKind
  items: ExplainMonthFinding[]
}) {
  const Icon = KIND_ICON[kind]
  if (items.length === 0) return null
  return (
    /* aria-label on the section — expand Card classes */
    <section className={CARD_CLS} aria-label={KIND_LABEL[kind]}>
      {/*
       * FindingGroup header: Icon + h3 + Badge count. SectionHeader expects
       * title+description+actions (top-right controls). The icon and count badge
       * live inline with the h3 title — not in the actions slot. Bespoke flex
       * row is the right shape here; SectionHeader would require wrapping the
       * Icon+label into the title prop and the Badge into actions, which misrepresents
       * their semantic relationship. Keep as token utilities.
       */}
      <div className="flex gap-2 items-center mb-2">
        <Icon size={18} aria-hidden="true" />
        <h3 className="m-0">{KIND_LABEL[kind]}</h3>
        <Badge variant="outline">{items.length}</Badge>
      </div>
      <ul className="m-0 p-0 list-none">
        {items.map((item) => (
          <li
            key={item.id}
            className="py-[10px] border-b border-border grid grid-cols-[1fr_auto] gap-3 items-center"
          >
            <div>
              <div className="flex gap-2 items-center flex-wrap">
                <Badge variant={SEVERITY_BADGE[item.severity]}>
                  {item.severity}
                </Badge>
                <strong>{item.title}</strong>
              </div>
              <p className="mt-1 m-0">{item.summary}</p>
            </div>
            {/* .muted on a Link — inline context, no mb-4 appropriate */}
            <Link
              to={buildTransactionsHref(item.transactionFilter)}
              className="text-sm leading-6 text-muted-foreground"
            >
              View transactions
            </Link>
          </li>
        ))}
      </ul>
    </section>
  )
}
