import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { EmptyState } from '@/components/ui/empty-state'
import { FilterBar, type QuickRange } from '@/components/ui/filter-bar'
import { PageHeader } from '@/components/ui/page-header'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { getJson } from '../lib/api'
import { toDateInputValue } from '../lib/dateInput'
import { formatMoney } from '../lib/formatMoney'
import { summaryQueryString } from '../lib/summaryQuery'
import { useSessionState } from '../lib/useSessionState'
import type {
  PartnerFairnessByCurrency,
  PartnerFairnessMonthlyPoint,
  PartnerFairnessMonthlyResponse,
  PartnerFairnessResponse,
  PartnerSettlementRecommendation,
  PartnerSettlementRecommendationResponse,
} from '../types/api'

const DEFAULT_PARTNER_CURRENCY = 'CAD'

/** Compute first/last day of a relative window for the FilterBar. */
function getRelativeRange(days: number): { from: string; to: string } {
  const to = new Date()
  const from = new Date(to)
  from.setDate(from.getDate() - days)
  return { from: toDateInputValue(from), to: toDateInputValue(to) }
}

function getYearToDate(): { from: string; to: string } {
  const to = new Date()
  const from = new Date(to.getFullYear(), 0, 1)
  return { from: toDateInputValue(from), to: toDateInputValue(to) }
}

/**
 * /partner — shared-finance fairness dashboard (issue #207). Aggregates the
 * three GET /api/partner/* endpoints into one page:
 *   - /fairness → per-currency summary (balance, paidMore, breakdown, largest)
 *   - /monthly → historical trend
 *   - /settlement-recommendation → suggested next settlement
 *
 * Filters: currency + date range. Default view is "all time" so the
 * settlement recommendation reflects the true lifetime balance.
 */
export function PartnerFairnessPage() {
  const [currency, setCurrency] = useSessionState(
    'partner.currency',
    DEFAULT_PARTNER_CURRENCY,
  )
  const [dateFrom, setDateFrom] = useSessionState('partner.dateFrom', '')
  const [dateTo, setDateTo] = useSessionState('partner.dateTo', '')

  const [fairness, setFairness] = useState<PartnerFairnessByCurrency[]>([])
  const [monthly, setMonthly] = useState<PartnerFairnessMonthlyPoint[]>([])
  const [recommendations, setRecommendations] = useState<PartnerSettlementRecommendation[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)

  const qs = useMemo(
    () => summaryQueryString({ currency, dateFrom, dateTo }),
    [currency, dateFrom, dateTo],
  )

  const quickRanges = useMemo<QuickRange[]>(
    () => [
      { key: '30d', label: '30 days', ...getRelativeRange(30) },
      { key: '90d', label: '90 days', ...getRelativeRange(90) },
      { key: 'ytd', label: 'YTD', ...getYearToDate() },
      { key: 'all', label: 'All time', from: '', to: '' },
    ],
    [],
  )

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setErr(null)
    Promise.all([
      getJson<PartnerFairnessResponse>(`/api/partner/fairness${qs}`),
      getJson<PartnerFairnessMonthlyResponse>(`/api/partner/monthly${qs}`),
      getJson<PartnerSettlementRecommendationResponse>(
        `/api/partner/settlement-recommendation${qs}`,
      ),
    ])
      .then(([f, m, r]) => {
        if (cancelled) return
        setFairness(f.byCurrency)
        setMonthly(m.points)
        setRecommendations(r.recommendations)
      })
      .catch((e: unknown) => {
        if (!cancelled) setErr(e instanceof Error ? e.message : 'Error')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [qs])

  return (
    <>
      <PageHeader
        title="Partner fairness"
        description="Shared spending, who covered what, and the next settlement."
      />
      <Card className="mb-4">
        <CardContent className="pt-6">
          <FilterBar
            currency={currency}
            onCurrencyChange={(v) => setCurrency(v || DEFAULT_PARTNER_CURRENCY)}
            dateFrom={dateFrom}
            dateTo={dateTo}
            onDateChange={(from, to) => {
              setDateFrom(from)
              setDateTo(to)
            }}
            quickRanges={quickRanges}
            quickRangesLabel="Range"
          />
        </CardContent>
      </Card>

      {err && (
        <Card className="mb-4 border-rose-300 bg-rose-50 dark:border-rose-700 dark:bg-rose-950">
          <CardContent className="pt-6">
            <p className="text-rose-800 dark:text-rose-200">{err}</p>
          </CardContent>
        </Card>
      )}

      {loading ? (
        <Card>
          <CardContent className="pt-6">
            <p className="muted">Loading…</p>
          </CardContent>
        </Card>
      ) : fairness.length === 0 ? (
        <EmptyState
          title="No shared activity yet"
          description="Tag transactions as split or with a contact to start tracking partner fairness."
        />
      ) : (
        <div className="grid gap-4">
          {fairness.map((byCurrency) => (
            <PartnerFairnessSection
              key={byCurrency.currency}
              data={byCurrency}
              monthly={monthly.filter((p) => p.currency === byCurrency.currency)}
              recommendation={recommendations.find(
                (r) => r.currency === byCurrency.currency,
              )}
            />
          ))}
        </div>
      )}
    </>
  )
}

function directionLabel(d: 'partner_owes_me' | 'i_owe_partner' | 'even'): string {
  if (d === 'partner_owes_me') return 'Partner owes you'
  if (d === 'i_owe_partner') return 'You owe partner'
  return 'Even'
}

function recommendationLabel(
  d: 'partner_pays_you' | 'you_pay_partner' | 'none',
): string {
  if (d === 'partner_pays_you') return 'Partner pays you'
  if (d === 'you_pay_partner') return 'You pay partner'
  return 'You are square'
}

function PartnerFairnessSection({
  data,
  monthly,
  recommendation,
}: {
  data: PartnerFairnessByCurrency
  monthly: PartnerFairnessMonthlyPoint[]
  recommendation: PartnerSettlementRecommendation | undefined
}) {
  const cur = data.currency
  return (
    <section className="grid gap-4">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-xl font-semibold">{cur}</h2>
        <p className="muted mb-0 text-sm">
          {data.sharedTransactionCount} shared transaction
          {data.sharedTransactionCount === 1 ? '' : 's'} in range
        </p>
      </header>

      {/* AC1 + AC2 + AC3 + AC4 — summary stats. */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Shared this month"
          value={formatMoney(data.currentMonthSharedSpend, cur)}
          hint="Total shared purchases the current calendar month"
        />
        <StatCard
          label="You covered"
          value={formatMoney(data.paidMore.youCovered, cur)}
          hint="Your out-of-pocket share of shared spend in range"
        />
        <StatCard
          label="Running balance"
          value={formatMoney(Math.abs(data.balance), cur)}
          hint={directionLabel(data.direction)}
          tone={
            data.direction === 'partner_owes_me'
              ? 'inflow'
              : data.direction === 'i_owe_partner'
                ? 'outflow'
                : 'neutral'
          }
        />
        <StatCard
          label="Settlement"
          value={
            recommendation && recommendation.direction !== 'none'
              ? formatMoney(recommendation.amount, cur)
              : '—'
          }
          hint={
            recommendation
              ? recommendationLabel(recommendation.direction)
              : 'No outstanding balance'
          }
          tone={
            recommendation?.direction === 'partner_pays_you'
              ? 'inflow'
              : recommendation?.direction === 'you_pay_partner'
                ? 'outflow'
                : 'neutral'
          }
        />
      </div>

      {/* AC5 — category breakdown of shared spend. */}
      <Card>
        <CardHeader>
          <CardTitle>Category breakdown</CardTitle>
        </CardHeader>
        <CardContent>
          {data.categoryBreakdown.length === 0 ? (
            <p className="muted">No categorized shared spend in range.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Category</TableHead>
                  <TableHead className="text-right">Shared spend</TableHead>
                  <TableHead className="text-right">Your share</TableHead>
                  <TableHead className="text-right">Partner share</TableHead>
                  <TableHead className="text-right">Txns</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.categoryBreakdown.map((row) => (
                  <TableRow key={row.category}>
                    <TableCell>{row.category}</TableCell>
                    <TableCell className="text-right">
                      {formatMoney(row.sharedSpend, cur)}
                    </TableCell>
                    <TableCell className="text-right">
                      {formatMoney(row.myShare, cur)}
                    </TableCell>
                    <TableCell className="text-right">
                      {formatMoney(row.partnerShare, cur)}
                    </TableCell>
                    <TableCell className="text-right">{row.transactionCount}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* AC6 — historical fairness trend. */}
      <Card>
        <CardHeader>
          <CardTitle>Monthly trend</CardTitle>
        </CardHeader>
        <CardContent>
          {monthly.length === 0 ? (
            <p className="muted">No monthly shared activity in range.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Month</TableHead>
                  <TableHead className="text-right">Shared spend</TableHead>
                  <TableHead className="text-right">Partner share</TableHead>
                  <TableHead className="text-right">Settlement Δ</TableHead>
                  <TableHead className="text-right">Net Δ</TableHead>
                  <TableHead className="text-right">Cumulative balance</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {monthly.map((p) => (
                  <TableRow key={`${p.currency}-${p.month}`}>
                    <TableCell>{p.month}</TableCell>
                    <TableCell className="text-right">
                      {formatMoney(p.sharedSpend, cur)}
                    </TableCell>
                    <TableCell className="text-right">
                      {formatMoney(p.partnerShare, cur)}
                    </TableCell>
                    <TableCell className="text-right">
                      {formatMoney(p.settlementDelta, cur)}
                    </TableCell>
                    <TableCell className="text-right">
                      {formatMoney(p.netDelta, cur)}
                    </TableCell>
                    <TableCell className="text-right font-medium">
                      {formatMoney(p.cumulativeBalance, cur)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* AC7 — largest shared transactions. */}
      <Card>
        <CardHeader>
          <CardTitle>Largest shared transactions</CardTitle>
        </CardHeader>
        <CardContent>
          {data.largestShared.length === 0 ? (
            <p className="muted">No shared transactions in range.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead>Merchant</TableHead>
                  <TableHead>Category</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                  <TableHead className="text-right">Partner share</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.largestShared.map((row) => (
                  <TableRow key={row.txnId}>
                    <TableCell>{row.date}</TableCell>
                    <TableCell>
                      <Link
                        to={`/transactions?merchant=${encodeURIComponent(row.merchant)}`}
                        className="underline-offset-2 hover:underline"
                      >
                        {row.merchant}
                      </Link>
                    </TableCell>
                    <TableCell>{row.category ?? 'Uncategorized'}</TableCell>
                    <TableCell className="text-right">
                      {formatMoney(row.amount, cur)}
                    </TableCell>
                    <TableCell className="text-right">
                      {formatMoney(row.partnerShare, cur)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </section>
  )
}

/**
 * Minimal local stat card. The shared `<StatCard>` primitive renders as a
 * full-width block; here we want a compact tile grid driven by Tailwind
 * utilities, which is simpler to inline than wedge into the existing API.
 */
function StatCard({
  label,
  value,
  hint,
  tone = 'neutral',
}: {
  label: string
  value: string
  hint: string
  tone?: 'inflow' | 'outflow' | 'neutral'
}) {
  const valueTone =
    tone === 'inflow'
      ? 'text-emerald-700 dark:text-emerald-300'
      : tone === 'outflow'
        ? 'text-rose-700 dark:text-rose-300'
        : 'text-zinc-900 dark:text-zinc-100'
  return (
    <Card>
      <CardContent className="pt-6">
        <p className="text-xs uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
          {label}
        </p>
        <p className={`mt-1 text-2xl font-semibold ${valueTone}`}>{value}</p>
        <p className="muted mt-1 text-xs">{hint}</p>
      </CardContent>
    </Card>
  )
}
