import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { AlertTriangle, CheckCircle2, TrendingDown, TrendingUp } from 'lucide-react'
import { Alert } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { EmptyState } from '@/components/ui/empty-state'
import { Card } from '@/components/ui/card'
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

  const queryString = useMemo(() => {
    const params = new URLSearchParams()
    params.set('month', month)
    params.set('months', String(months))
    params.set('scope', scope)
    if (currency) params.set('currency', currency)
    return params.toString()
  }, [month, months, scope, currency])

  const { data, loading, err, reload, availableCurrencies, windowLabel } =
    useReportData<LifestyleInflationResponse>(
      `/api/reports/lifestyle-inflation?${queryString}`,
      currency,
    )

  return (
    <div className="page">
      <PageHeader
        title="Lifestyle inflation"
        description="Track whether your spending is creeping up faster than your income. Compares the first half of the window to the most recent half."
      />

      <Card className="mb-4">
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
          onRefresh={reload}
        />
        {windowLabel && (
          <p className="text-sm leading-6 text-muted-foreground mt-2 mb-0">
            Showing {windowLabel}.
          </p>
        )}
      </Card>

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
          title={`No spending data for ${windowLabel || 'this window'}`}
          description={`No transactions${scope !== 'all' ? ` in the ${scope} scope` : ''}${currency ? ` (${currency})` : ''}. Import transactions or widen the window.`}
        />
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
    <section className="rounded-lg border border-border bg-card p-4 text-card-foreground shadow-sm sm:p-5 mb-4" aria-label={`Lifestyle inflation — ${trend.currency}`}>
      <SectionHeader
        title={trend.currency}
        actions={<OutpacingBadge outpacing={trend.spendOutpacingIncome} />}
      />

      {trend.insight && (
        <Alert
          variant={trend.spendOutpacingIncome ? 'warning' : 'info'}
          className="mb-3"
        >
          <div className="flex gap-2 items-center mb-1">
            <AlertTriangle size={18} aria-hidden="true" />
            <Badge variant={SEVERITY_BADGE[trend.insight.severity]}>
              {trend.insight.severity}
            </Badge>
            <strong>{trend.insight.title}</strong>
          </div>
          <p className="m-0">{trend.insight.summary}</p>
        </Alert>
      )}

      <Grid minItemWidth={180} gap="md" className="mb-3">
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
      </Grid>

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
  // Computed delta color: --accent-green (==--positive) for good, --danger for bad,
  // muted when flat. StatCard's metricKind chip uses the same tokens under the hood
  // (--positive / --destructive), so the color semantics are equivalent. We preserve
  // the raw inline color here because StatCard's delta chip applies a bordered-badge
  // style that differs visually from the original plain inline row.
  const deltaColor =
    delta === 0
      ? 'var(--muted-foreground, inherit)'
      : good
        ? 'var(--accent-green)'
        : 'var(--danger)'
  const TrendIcon = rising ? TrendingUp : TrendingDown
  return (
    <StatCard
      label={label}
      value={formatMoney(secondHalf, currency)}
      hint={`from ${formatMoney(firstHalf, currency)}`}
      delta={
        <span style={{ color: deltaColor }}>
          <TrendIcon size={14} aria-hidden="true" /> {formatPct(pct)}
        </span>
      }
    />
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
    <div className="mt-3">
      <h3 className="m-0 mb-1.5">What's driving the growth</h3>
      <ul className="m-0 p-0 list-none">
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
              className="text-sm leading-6 text-muted-foreground"
            >
              {d.category}
            </Link>
            <span className="text-danger">
              +{formatMoney(d.delta, currency)}/mo
            </span>
            <span className="text-sm leading-6 text-muted-foreground">{formatPct(d.deltaPct)}</span>
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
    <div className="mt-3 overflow-x-auto">
      <h3 className="m-0 mb-1.5">Monthly detail</h3>
      <Table className="min-w-[360px]">
        <TableHeader>
          <TableRow>
            <TableHead>Month</TableHead>
            <TableHead className="text-right">Income</TableHead>
            <TableHead className="text-right">Spend</TableHead>
            <TableHead className="text-right">Savings</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {series.map((m) => (
            <TableRow key={m.month}>
              <TableCell>{m.month}</TableCell>
              <TableCell className="text-right">
                {formatMoney(m.income, currency)}
              </TableCell>
              <TableCell className="text-right">
                {formatMoney(m.spend, currency)}
              </TableCell>
              <TableCell
                className="text-right"
                style={{
                  color: m.savings < 0 ? 'var(--danger)' : undefined,
                }}
              >
                {formatMoney(m.savings, currency)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}
