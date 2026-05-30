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
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { NativeSelect } from '@/components/ui/native-select'
import { PageHeader } from '@/components/ui/page-header'
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

      <section className="card">
        <div
          style={{
            display: 'flex',
            gap: 12,
            alignItems: 'flex-end',
            flexWrap: 'wrap',
          }}
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <label htmlFor="explain-month-month">Month</label>
            <input
              id="explain-month-month"
              type="month"
              value={month}
              onChange={(e) => setMonth(e.target.value)}
              className="input"
              style={{ minWidth: 160 }}
            />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
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
          <label
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              cursor: 'pointer',
            }}
          >
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
      </section>

      {err && (
        <section className="card">
          <p className="error" role="alert">
            {err}
          </p>
        </section>
      )}

      {loading && !data ? (
        <section className="card" aria-busy="true">
          <p className="muted">Building the report…</p>
        </section>
      ) : !data ? null : (
        <>
          {data.aiSummary != null && (
            <section className="card" aria-label="AI summary">
              <div
                style={{
                  display: 'flex',
                  gap: 8,
                  alignItems: 'flex-start',
                }}
              >
                <Sparkles size={18} aria-hidden="true" />
                <p style={{ margin: 0 }}>{data.aiSummary}</p>
              </div>
            </section>
          )}
          {aiOptIn && data.aiSummary == null && (
            <section className="card">
              <p className="muted">
                AI summary unavailable — OPENAI_API_KEY is not configured on the
                server. The rest of the report below is deterministic and does
                not require AI.
              </p>
            </section>
          )}

          <MonthOverMonthSection data={data} />

          {(data.findings ?? []).length === 0 ? (
            <section className="card">
              <p className="muted">
                Nothing notable for {data.month}. Spend levels match the
                previous month, no subscriptions changed, and there are no
                review-blocked transactions.
              </p>
            </section>
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
    <section className="card" aria-label="Month over month totals">
      <h2 style={{ marginTop: 0 }}>
        {data.month} vs {data.previousMonth}
      </h2>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
          gap: 12,
        }}
      >
        {data.monthOverMonth.map((mom) => {
          const spendUp = mom.spendDelta > 0
          const trendIcon = spendUp ? (
            <TrendingUp size={16} aria-hidden="true" />
          ) : (
            <TrendingDown size={16} aria-hidden="true" />
          )
          return (
            <div
              key={mom.currency}
              style={{
                border: '1px solid var(--border)',
                borderRadius: 6,
                padding: 12,
              }}
            >
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                }}
              >
                <strong>{mom.currency}</strong>
                {trendIcon}
              </div>
              <dl
                style={{
                  margin: '8px 0 0',
                  display: 'grid',
                  gridTemplateColumns: 'auto 1fr',
                  rowGap: 4,
                  columnGap: 8,
                }}
              >
                <dt className="muted">Spend</dt>
                <dd style={{ margin: 0, textAlign: 'right' }}>
                  {formatMoney(mom.currentSpend, mom.currency)}{' '}
                  <span className="muted">
                    ({mom.spendDelta >= 0 ? '+' : ''}
                    {formatMoney(mom.spendDelta, mom.currency)})
                  </span>
                </dd>
                <dt className="muted">Income</dt>
                <dd style={{ margin: 0, textAlign: 'right' }}>
                  {formatMoney(mom.currentIncome, mom.currency)}{' '}
                  <span className="muted">
                    ({mom.incomeDelta >= 0 ? '+' : ''}
                    {formatMoney(mom.incomeDelta, mom.currency)})
                  </span>
                </dd>
                <dt className="muted">Net</dt>
                <dd style={{ margin: 0, textAlign: 'right' }}>
                  {formatMoney(mom.netCurrent, mom.currency)}{' '}
                  <span className="muted">
                    ({mom.netDelta >= 0 ? '+' : ''}
                    {formatMoney(mom.netDelta, mom.currency)})
                  </span>
                </dd>
              </dl>
            </div>
          )
        })}
      </div>
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
    <section className="card" aria-label={KIND_LABEL[kind]}>
      <div
        style={{
          display: 'flex',
          gap: 8,
          alignItems: 'center',
          marginBottom: 8,
        }}
      >
        <Icon size={18} aria-hidden="true" />
        <h3 style={{ margin: 0 }}>{KIND_LABEL[kind]}</h3>
        <Badge variant="outline">{items.length}</Badge>
      </div>
      <ul style={{ margin: 0, padding: 0, listStyle: 'none' }}>
        {items.map((item) => (
          <li
            key={item.id}
            style={{
              padding: '10px 0',
              borderBottom: '1px solid var(--border)',
              display: 'grid',
              gridTemplateColumns: '1fr auto',
              gap: 12,
              alignItems: 'center',
            }}
          >
            <div>
              <div
                style={{
                  display: 'flex',
                  gap: 8,
                  alignItems: 'center',
                  flexWrap: 'wrap',
                }}
              >
                <Badge variant={SEVERITY_BADGE[item.severity]}>
                  {item.severity}
                </Badge>
                <strong>{item.title}</strong>
              </div>
              <p style={{ margin: '4px 0 0' }}>{item.summary}</p>
            </div>
            <Link
              to={buildTransactionsHref(item.transactionFilter)}
              className="muted"
            >
              View transactions
            </Link>
          </li>
        ))}
      </ul>
    </section>
  )
}
