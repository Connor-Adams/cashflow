import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { AlertTriangle, CheckCircle2, TrendingDown, TrendingUp } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { PageHeader } from '@/components/ui/page-header'
import { getJson } from '../lib/api'
import { formatMoney } from '../lib/formatMoney'
import { ReportFilterBar } from './report/ReportFilterBar'
import { defaultReportMonth, type ScopeOption } from './report/reportFilters'
import type {
  LifestyleCategoryDriver,
  LifestyleCurrencyTrend,
  LifestyleInflationResponse,
  LifestyleInflationSeverity,
  LifestyleMonthlyPoint,
  LifestyleScope,
} from '../types/api'

/**
 * LifestyleInflationPage — renders the lifestyle inflation tracker (Cashflow
 * #245). Pulls a rolling-window trend from /api/reports/lifestyle-inflation
 * and shows, per currency: whether spending is outpacing income, the monthly
 * income/spend/savings series, the categories driving spend growth, and a
 * warning insight when inflation is creeping in.
 *
 * "Growth" is a first-half-vs-second-half average comparison computed on the
 * backend, which keeps this page a thin presentation layer over the
 * deterministic aggregator.
 */

const SEVERITY_BADGE: Record<
  LifestyleInflationSeverity,
  'default' | 'secondary' | 'outline' | 'destructive'
> = {
  high: 'destructive',
  medium: 'default',
  low: 'secondary',
}

const SCOPE_OPTIONS: ScopeOption[] = [
  { value: 'all', label: 'All spend' },
  { value: 'personal', label: 'Personal' },
  { value: 'shared', label: 'Shared' },
  { value: 'business', label: 'Business' },
]

/** Format a percentage-change value (may be null when there's no baseline). */
function formatPct(pct: number | null): string {
  if (pct == null) return 'n/a'
  const rounded = Math.round(pct)
  return `${rounded > 0 ? '+' : ''}${rounded}%`
}

export function LifestyleInflationPage() {
  const [month, setMonth] = useState<string>(defaultReportMonth())
  const [months, setMonths] = useState<number>(12)
  const [currency, setCurrency] = useState<string>('')
  const [scope, setScope] = useState<LifestyleScope>('all')
  const [data, setData] = useState<LifestyleInflationResponse | null>(null)
  const [loading, setLoading] = useState<boolean>(true)
  const [err, setErr] = useState<string | null>(null)

  const queryString = useMemo(() => {
    const params = new URLSearchParams()
    params.set('month', month)
    params.set('months', String(months))
    params.set('scope', scope)
    if (currency) params.set('currency', currency)
    return params.toString()
  }, [month, months, scope, currency])

  const load = useCallback(async () => {
    setLoading(true)
    setErr(null)
    try {
      const res = await getJson<LifestyleInflationResponse>(
        `/api/reports/lifestyle-inflation?${queryString}`,
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

  // Currencies present in the loaded data drive the picker so it never
  // collapses when a filter is applied.
  const availableCurrencies = useMemo(() => {
    const set = new Set<string>()
    for (const t of data?.byCurrency ?? []) set.add(t.currency)
    if (currency) set.add(currency)
    return Array.from(set).sort()
  }, [data, currency])

  const windowLabel = useMemo(() => {
    const w = data?.windowMonths ?? []
    if (w.length === 0) return ''
    return `${w[0]} – ${w[w.length - 1]}`
  }, [data])

  return (
    <div className="page">
      <PageHeader
        title="Lifestyle inflation"
        description="Track whether your spending is creeping up faster than your income. Compares the first half of the window to the most recent half."
      />

      <section className="card">
        <ReportFilterBar
          idPrefix="lifestyle"
          month={month}
          onMonthChange={setMonth}
          months={months}
          onMonthsChange={setMonths}
          scope={scope}
          onScopeChange={setScope}
          scopeOptions={SCOPE_OPTIONS}
          currency={currency}
          onCurrencyChange={setCurrency}
          availableCurrencies={availableCurrencies}
          loading={loading}
          onRefresh={() => {
            void load()
          }}
        />
        {windowLabel && (
          <p className="muted" style={{ margin: '8px 0 0' }}>
            Showing {windowLabel}.
          </p>
        )}
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
      ) : !data ? null : data.byCurrency.length === 0 ? (
        <section className="card">
          <p className="muted">
            No spending data for {windowLabel || 'this window'}
            {scope !== 'all' ? ` in the ${scope} scope` : ''}
            {currency ? ` (${currency})` : ''}. Import transactions or widen the
            window.
          </p>
        </section>
      ) : (
        data.byCurrency.map((trend) => (
          <CurrencyTrendCard key={trend.currency} trend={trend} />
        ))
      )}
    </div>
  )
}

function CurrencyTrendCard({ trend }: { trend: LifestyleCurrencyTrend }) {
  return (
    <section className="card" aria-label={`Lifestyle inflation — ${trend.currency}`}>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: 8,
        }}
      >
        <h2 style={{ margin: 0 }}>{trend.currency}</h2>
        <OutpacingBadge outpacing={trend.spendOutpacingIncome} />
      </div>

      {trend.insight && (
        <div
          role="alert"
          style={{
            display: 'flex',
            gap: 8,
            alignItems: 'flex-start',
            border: '1px solid var(--border)',
            borderRadius: 6,
            padding: 12,
            marginBottom: 12,
          }}
        >
          <AlertTriangle size={18} aria-hidden="true" />
          <div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <Badge variant={SEVERITY_BADGE[trend.insight.severity]}>
                {trend.insight.severity}
              </Badge>
              <strong>{trend.insight.title}</strong>
            </div>
            <p style={{ margin: '4px 0 0' }}>{trend.insight.summary}</p>
          </div>
        </div>
      )}

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
          gap: 12,
        }}
      >
        <GrowthStat
          label="Avg monthly spend"
          firstHalf={trend.spendGrowth.firstHalfAvg}
          secondHalf={trend.spendGrowth.secondHalfAvg}
          pct={trend.spendGrowthPct}
          currency={trend.currency}
          /* Rising spend is the bad direction here. */
          invert
        />
        <GrowthStat
          label="Avg monthly income"
          firstHalf={trend.incomeGrowth.firstHalfAvg}
          secondHalf={trend.incomeGrowth.secondHalfAvg}
          pct={trend.incomeGrowthPct}
          currency={trend.currency}
        />
        <GrowthStat
          label="Avg monthly savings"
          firstHalf={trend.savingsGrowth.firstHalfAvg}
          secondHalf={trend.savingsGrowth.secondHalfAvg}
          pct={trend.savingsGrowthPct}
          currency={trend.currency}
        />
      </div>

      <CategoryDrivers drivers={trend.categoryDrivers} currency={trend.currency} />

      <MonthlySeriesTable series={trend.series} currency={trend.currency} />
    </section>
  )
}

function OutpacingBadge({ outpacing }: { outpacing: boolean }) {
  if (outpacing) {
    return (
      <Badge variant="destructive">
        <TrendingUp size={14} aria-hidden="true" /> Spending outpacing income
      </Badge>
    )
  }
  return (
    <Badge variant="secondary">
      <CheckCircle2 size={14} aria-hidden="true" /> In check
    </Badge>
  )
}

function GrowthStat({
  label,
  firstHalf,
  secondHalf,
  pct,
  currency,
  invert = false,
}: {
  label: string
  firstHalf: number
  secondHalf: number
  pct: number | null
  currency: string
  /** When true, an increase is rendered as concerning (red), e.g. spend. */
  invert?: boolean
}) {
  const delta = secondHalf - firstHalf
  const rising = delta > 0
  // For spend, rising is bad (red). For income/savings, rising is good (green).
  const good = invert ? !rising : rising
  const color =
    delta === 0
      ? 'var(--muted-foreground, inherit)'
      : good
        ? 'var(--accent-green)'
        : 'var(--danger)'
  const TrendIcon = rising ? TrendingUp : TrendingDown
  return (
    <div
      style={{
        border: '1px solid var(--border)',
        borderRadius: 6,
        padding: 12,
      }}
    >
      <p className="muted" style={{ margin: 0 }}>
        {label}
      </p>
      <p style={{ margin: '4px 0 0', fontSize: '1.25rem', fontWeight: 600 }}>
        {formatMoney(secondHalf, currency)}
      </p>
      <p style={{ margin: '2px 0 0', color }}>
        <TrendIcon size={14} aria-hidden="true" /> {formatPct(pct)}{' '}
        <span className="muted">from {formatMoney(firstHalf, currency)}</span>
      </p>
    </div>
  )
}

function CategoryDrivers({
  drivers,
  currency,
}: {
  drivers: LifestyleCategoryDriver[]
  currency: string
}) {
  const risers = drivers.filter((d) => d.delta > 0)
  if (risers.length === 0) return null
  return (
    <div style={{ marginTop: 12 }}>
      <h3 style={{ margin: '0 0 6px' }}>What's driving the growth</h3>
      <ul style={{ margin: 0, padding: 0, listStyle: 'none' }}>
        {risers.map((d) => (
          <li
            key={d.category}
            style={{
              display: 'grid',
              gridTemplateColumns: '1fr auto auto',
              gap: 12,
              alignItems: 'center',
              padding: '8px 0',
              borderBottom: '1px solid var(--border)',
            }}
          >
            <Link
              to={`/transactions?category=${encodeURIComponent(d.category)}&currency=${currency}`}
              className="muted"
            >
              {d.category}
            </Link>
            <span style={{ color: 'var(--danger)' }}>
              +{formatMoney(d.delta, currency)}/mo
            </span>
            <span className="muted">{formatPct(d.deltaPct)}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

function MonthlySeriesTable({
  series,
  currency,
}: {
  series: LifestyleMonthlyPoint[]
  currency: string
}) {
  if (series.length === 0) return null
  return (
    <div style={{ marginTop: 12, overflowX: 'auto' }}>
      <h3 style={{ margin: '0 0 6px' }}>Monthly detail</h3>
      <table className="table" style={{ minWidth: 360 }}>
        <thead>
          <tr>
            <th style={{ textAlign: 'left' }}>Month</th>
            <th style={{ textAlign: 'right' }}>Income</th>
            <th style={{ textAlign: 'right' }}>Spend</th>
            <th style={{ textAlign: 'right' }}>Savings</th>
          </tr>
        </thead>
        <tbody>
          {series.map((m) => (
            <tr key={m.month}>
              <td>{m.month}</td>
              <td style={{ textAlign: 'right' }}>
                {formatMoney(m.income, currency)}
              </td>
              <td style={{ textAlign: 'right' }}>
                {formatMoney(m.spend, currency)}
              </td>
              <td
                style={{
                  textAlign: 'right',
                  color: m.savings < 0 ? 'var(--danger)' : undefined,
                }}
              >
                {formatMoney(m.savings, currency)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
