import { useMemo, useState } from 'react'
import { PiggyBank, TrendingDown, TrendingUp } from 'lucide-react'
import { Alert } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Card } from '@/components/ui/card'
import { EmptyState } from '@/components/ui/empty-state'
import { Grid } from '@/components/ui/grid'
import { PageHeader } from '@/components/ui/page-header'
import { SectionHeader } from '@/components/ui/section-header'
import { StatCard } from '@/components/ui/stat-card'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
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

      <Card className="mb-4">
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
          <p className="text-sm leading-6 text-muted-foreground mt-2 mb-0">
            Showing {windowLabel}.
          </p>
        )}
      </Card>

      <FormulaExplainer
        includeInvestments={includeInvestments}
        includeDebtPrincipal={includeDebtPrincipal}
      />

      {err && (
        <Alert variant="error" className="mb-4">
          {err}
        </Alert>
      )}

      {loading && !data ? (
        <Card className="mb-4" aria-busy="true">
          <p className="text-sm leading-6 text-muted-foreground mb-0">Building the report…</p>
        </Card>
      ) : !data ? null : data.byCurrency.length === 0 ? (
        <EmptyState
          className="mb-4"
          title={`No activity for ${windowLabel || 'this window'}`}
          description={`No income or savings${scope !== 'all' ? ` in the ${scope} scope` : ''}${currency ? ` (${currency})` : ''}. Import transactions or widen the window.`}
        />
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
    <section className="rounded-lg border border-border bg-card p-4 text-card-foreground shadow-sm sm:p-5 mb-4" aria-label="How the savings rate is calculated">
      <h2 className="m-0 mb-1.5 text-base">How this is calculated</h2>
      <p className="mb-2">
        <code>
          savings rate = ({numerator}) ÷ income
        </code>
      </p>
      <ul className="text-sm leading-6 text-muted-foreground m-0 pl-4">
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
      <p className="text-sm leading-6 text-muted-foreground mt-2 mb-0">
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
    <section className="rounded-lg border border-border bg-card p-4 text-card-foreground shadow-sm sm:p-5 mb-4" aria-label={`Savings rate — ${summary.currency}`}>
      <SectionHeader
        title={summary.currency}
        actions={<RateBadge pct={totals.savingsRatePct} />}
      />

      <Grid minItemWidth={150} gap="md">
        <StatCard label="Income" value={formatMoney(totals.income, summary.currency)} />
        <StatCard label="Spending" value={formatMoney(totals.spending, summary.currency)} />
        <StatCard label="Savings" value={formatMoney(totals.savings, summary.currency)} />
        <StatCard label="Investments" value={formatMoney(totals.investments, summary.currency)} />
        <StatCard label="Debt principal" value={formatMoney(totals.debtPrincipal, summary.currency)} />
      </Grid>

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
      <Table className="min-w-[520px]">
        <TableHeader>
          <TableRow>
            <TableHead>Month</TableHead>
            <TableHead className="text-right">Income</TableHead>
            <TableHead className="text-right">Spending</TableHead>
            <TableHead className="text-right">Savings</TableHead>
            <TableHead className="text-right">Investments</TableHead>
            <TableHead className="text-right">Debt principal</TableHead>
            <TableHead className="text-right">Savings rate</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {series.map((m) => (
            <TableRow key={m.month}>
              <TableCell>{m.month}</TableCell>
              <TableCell className="text-right">{formatMoney(m.income, currency)}</TableCell>
              <TableCell className="text-right">{formatMoney(m.spending, currency)}</TableCell>
              <TableCell className="text-right">{formatMoney(m.savings, currency)}</TableCell>
              <TableCell className="text-right">
                {formatMoney(m.investments, currency)}
              </TableCell>
              <TableCell className="text-right">
                {formatMoney(m.debtPrincipal, currency)}
              </TableCell>
              <TableCell
                className={
                  m.savingsRatePct == null
                    ? 'text-right text-muted-foreground'
                    : m.savingsRatePct < 0
                      ? 'text-right text-danger'
                      : 'text-right'
                }
              >
                {formatRate(m.savingsRatePct)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}
