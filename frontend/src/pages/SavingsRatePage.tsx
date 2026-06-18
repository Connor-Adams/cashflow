import { useMemo, useState } from 'react'
import { PiggyBank, TrendingDown, TrendingUp } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { PageHeader } from '@/components/ui/page-header'
import { formatMoney } from '../lib/formatMoney'
import { ReportFilterBar } from './report/ReportFilterBar'
import { defaultReportMonth, type ScopeOption } from './report/reportFilters'
import { useReportData } from './report/useReportData'
import type {
  LifestyleScope,
  SavingsRateCurrencySummary,
  SavingsRateMonthlyPoint,
  SavingsRateResponse,
} from '../types/api'

/**
 * SavingsRatePage — renders the savings rate dashboard (Cashflow #246).
 *
 * Pulls a rolling-window breakdown from /api/reports/savings-rate and shows,
 * per currency: an overall "true" savings rate, the five money components that
 * make it up (income, spending, savings, investments, debt principal), and a
 * month-by-month trend. The user can toggle whether investment contributions
 * and debt-principal paydown count toward the rate — those toggles are sent to
 * the backend, which recomputes the numerator.
 *
 * Like LifestyleInflationPage (#245) this is a thin presentation layer over a
 * deterministic backend aggregator; all classification and math live in
 * backend/src/summary/savingsRate.ts.
 */

const SCOPE_OPTIONS: ScopeOption[] = [
  { value: 'all', label: 'All activity' },
  { value: 'personal', label: 'Personal' },
  { value: 'shared', label: 'Shared' },
  { value: 'business', label: 'Business' },
]

/** Format a savings-rate percentage (null when there was no income). */
function formatRate(pct: number | null): string {
  if (pct == null) return 'n/a'
  return `${Math.round(pct)}%`
}

export function SavingsRatePage() {
  const [month, setMonth] = useState<string>(defaultReportMonth())
  const [months, setMonths] = useState<number>(12)
  const [currency, setCurrency] = useState<string>('')
  const [scope, setScope] = useState<LifestyleScope>('all')
  const [includeInvestments, setIncludeInvestments] = useState<boolean>(true)
  const [includeDebtPrincipal, setIncludeDebtPrincipal] = useState<boolean>(true)

  const queryString = useMemo(() => {
    const params = new URLSearchParams()
    params.set('month', month)
    params.set('months', String(months))
    params.set('scope', scope)
    params.set('includeInvestments', String(includeInvestments))
    params.set('includeDebtPrincipal', String(includeDebtPrincipal))
    if (currency) params.set('currency', currency)
    return params.toString()
  }, [month, months, scope, currency, includeInvestments, includeDebtPrincipal])

  const { data, loading, err, reload, availableCurrencies, windowLabel } =
    useReportData<SavingsRateResponse>(
      `/api/reports/savings-rate?${queryString}`,
      currency,
    )

  return (
    <div className="page">
      <PageHeader
        title="Savings rate"
        description="Track your true savings rate over time — the share of income you keep as savings, investments, and debt paid down, rather than spend."
      />

      <section className="card">
        <ReportFilterBar
          idPrefix="savings"
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
          onRefresh={reload}
        />

        <div className="flex flex-wrap gap-4 mt-3">
          <label className="flex items-center gap-1.5">
            <input
              type="checkbox"
              checked={includeInvestments}
              onChange={(e) => setIncludeInvestments(e.target.checked)}
            />
            Count investment contributions as savings
          </label>
          <label className="flex items-center gap-1.5">
            <input
              type="checkbox"
              checked={includeDebtPrincipal}
              onChange={(e) => setIncludeDebtPrincipal(e.target.checked)}
            />
            Count debt principal paid down as savings
          </label>
        </div>

        {windowLabel && (
          <p className="muted mt-2">
            Showing {windowLabel}.
          </p>
        )}
      </section>

      <FormulaExplainer
        includeInvestments={includeInvestments}
        includeDebtPrincipal={includeDebtPrincipal}
      />

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
            No income or savings activity for {windowLabel || 'this window'}
            {scope !== 'all' ? ` in the ${scope} scope` : ''}
            {currency ? ` (${currency})` : ''}. Import transactions or widen the
            window.
          </p>
        </section>
      ) : (
        data.byCurrency.map((summary) => (
          <CurrencySummaryCard key={summary.currency} summary={summary} />
        ))
      )}
    </div>
  )
}

/**
 * Plain-English documentation of how the savings rate is computed (an explicit
 * acceptance criterion: "Calculation is documented in the UI"). Reflects the
 * current toggle state so the formula on screen matches the numbers.
 */
function FormulaExplainer({
  includeInvestments,
  includeDebtPrincipal,
}: {
  includeInvestments: boolean
  includeDebtPrincipal: boolean
}) {
  const numeratorParts = ['savings']
  if (includeInvestments) numeratorParts.push('investments')
  if (includeDebtPrincipal) numeratorParts.push('debt principal')
  const numerator = numeratorParts.join(' + ')
  return (
    <section className="card" aria-label="How the savings rate is calculated">
      <h2 className="m-0 mb-1.5 text-base">How this is calculated</h2>
      <p className="mb-2">
        <code>
          savings rate = ({numerator}) ÷ income
        </code>
      </p>
      <ul className="muted m-0 pl-4">
        <li>
          <strong>Income</strong> — money coming into your cash accounts
          (payroll, deposits). Statement payments and internal transfers are
          excluded.
        </li>
        <li>
          <strong>Spending</strong> — what you consumed (purchases, fees) on
          cash and credit-card accounts.
        </li>
        <li>
          <strong>Savings</strong> — money moved into savings accounts.
        </li>
        <li>
          <strong>Investments</strong> — contributions to investment accounts.
          {includeInvestments ? ' Counted toward your rate.' : ' Excluded from your rate (toggle above).'}
        </li>
        <li>
          <strong>Debt principal</strong> — payments that pay down loans and
          credit-card balances.
          {includeDebtPrincipal ? ' Counted toward your rate.' : ' Excluded from your rate (toggle above).'}
        </li>
      </ul>
      <p className="muted mt-2">
        Internal transfers are counted exactly once — the money landing in a
        savings, investment, or loan account is what counts, not the matching
        withdrawal from checking, so nothing is double counted.
      </p>
    </section>
  )
}

function CurrencySummaryCard({ summary }: { summary: SavingsRateCurrencySummary }) {
  const { totals } = summary
  return (
    <section className="card" aria-label={`Savings rate — ${summary.currency}`}>
      <div className="flex items-center justify-between mb-2">
        <h2 className="m-0">{summary.currency}</h2>
        <RateBadge pct={totals.savingsRatePct} />
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
          gap: 12,
        }}
      >
        <Stat label="Income" value={totals.income} currency={summary.currency} />
        <Stat label="Spending" value={totals.spending} currency={summary.currency} />
        <Stat label="Savings" value={totals.savings} currency={summary.currency} />
        <Stat label="Investments" value={totals.investments} currency={summary.currency} />
        <Stat
          label="Debt principal"
          value={totals.debtPrincipal}
          currency={summary.currency}
        />
      </div>

      <MonthlySeriesTable series={summary.series} currency={summary.currency} />
    </section>
  )
}

function RateBadge({ pct }: { pct: number | null }) {
  if (pct == null) {
    return <Badge variant="secondary">No income in window</Badge>
  }
  const positive = pct >= 0
  const Icon = positive ? TrendingUp : TrendingDown
  return (
    <Badge variant={positive ? 'default' : 'destructive'}>
      <PiggyBank size={14} aria-hidden="true" /> {formatRate(pct)} saved
      <Icon size={14} aria-hidden="true" />
    </Badge>
  )
}

function Stat({
  label,
  value,
  currency,
}: {
  label: string
  value: number
  currency: string
}) {
  return (
    <div
      style={{
        border: '1px solid var(--border)',
        borderRadius: 6,
        padding: 12,
      }}
    >
      <p className="muted m-0">
        {label}
      </p>
      <p className="m-0 mt-1 text-xl font-semibold">
        {formatMoney(value, currency)}
      </p>
    </div>
  )
}

function MonthlySeriesTable({
  series,
  currency,
}: {
  series: SavingsRateMonthlyPoint[]
  currency: string
}) {
  if (series.length === 0) return null
  return (
    <div className="mt-3 overflow-x-auto">
      <h3 className="mb-1.5 mt-0">Monthly detail</h3>
      <table className="table min-w-[520px]">
        <thead>
          <tr>
            <th>Month</th>
            <th className="text-right">Income</th>
            <th className="text-right">Spending</th>
            <th className="text-right">Savings</th>
            <th className="text-right">Investments</th>
            <th className="text-right">Debt principal</th>
            <th className="text-right">Savings rate</th>
          </tr>
        </thead>
        <tbody>
          {series.map((m) => (
            <tr key={m.month}>
              <td>{m.month}</td>
              <td className="text-right">{formatMoney(m.income, currency)}</td>
              <td className="text-right">{formatMoney(m.spending, currency)}</td>
              <td className="text-right">{formatMoney(m.savings, currency)}</td>
              <td className="text-right">
                {formatMoney(m.investments, currency)}
              </td>
              <td className="text-right">
                {formatMoney(m.debtPrincipal, currency)}
              </td>
              <td
                className="text-right"
                style={{
                  color:
                    m.savingsRatePct == null
                      ? 'var(--muted-foreground, inherit)'
                      : m.savingsRatePct < 0
                        ? 'var(--danger)'
                        : undefined,
                }}
              >
                {formatRate(m.savingsRatePct)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
