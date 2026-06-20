import { Card } from '@connor-adams/designsystem'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@connor-adams/designsystem'
import type { PortfolioSecurityOverview } from '../../types/api'

export type EarningsCardProps = {
  overview: PortfolioSecurityOverview | null
}

function formatEps(value: number | null, currencyCode?: string): string {
  if (value == null) return '—'
  if (currencyCode) {
    try {
      return new Intl.NumberFormat('en-CA', {
        style: 'currency',
        currency: currencyCode.toUpperCase(),
        maximumFractionDigits: 2,
        minimumFractionDigits: 2,
      }).format(value)
    } catch {
      return value.toFixed(2)
    }
  }
  return value.toFixed(2)
}

function formatRevenue(value: number | null, currencyCode?: string): string {
  if (value == null) return '—'
  const abs = Math.abs(value)
  let scaled = value
  let suffix = ''
  if (abs >= 1e12) {
    scaled = value / 1e12
    suffix = 'T'
  } else if (abs >= 1e9) {
    scaled = value / 1e9
    suffix = 'B'
  } else if (abs >= 1e6) {
    scaled = value / 1e6
    suffix = 'M'
  } else if (abs >= 1e3) {
    scaled = value / 1e3
    suffix = 'K'
  }
  const digits = abs >= 100 ? 1 : 2
  if (currencyCode) {
    try {
      const formatted = new Intl.NumberFormat('en-CA', {
        style: 'currency',
        currency: currencyCode.toUpperCase(),
        maximumFractionDigits: digits,
        minimumFractionDigits: 0,
      }).format(Math.abs(scaled))
      return `${scaled < 0 ? '-' : ''}${formatted}${suffix}`
    } catch {
      return `${scaled.toFixed(digits)}${suffix}`
    }
  }
  return `${scaled.toFixed(digits)}${suffix}`
}

function formatPercent(value: number | null): string {
  if (value == null) return '—'
  const digits = Math.abs(value) >= 10 ? 1 : 2
  const sign = value > 0 ? '+' : ''
  return `${sign}${value.toFixed(digits)}%`
}

function daysUntil(dateIso: string): { count: number; label: string } {
  const target = new Date(dateIso + (dateIso.length === 10 ? 'T00:00:00Z' : ''))
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const diffMs = target.getTime() - today.getTime()
  const days = Math.round(diffMs / 86400000)
  if (days === 0) return { count: 0, label: 'Today' }
  if (days > 0) return { count: days, label: `In ${days} ${days === 1 ? 'day' : 'days'}` }
  return { count: days, label: `${Math.abs(days)} ${days === -1 ? 'day' : 'days'} ago` }
}

export function EarningsCard({ overview }: EarningsCardProps) {
  if (!overview) return null

  const history = overview.earningsHistory ?? []
  const hasForecast = overview.nextEarningsDate != null || overview.earningsEpsAvg != null
  const hasHistory = history.length > 0
  if (!hasForecast && !hasHistory) return null

  const reportCurrency = (overview.financialCurrency ?? '').toUpperCase() || undefined
  const upcoming = overview.nextEarningsDate ? daysUntil(overview.nextEarningsDate) : null

  return (
    <Card>
      <div className="transactionsPanelHeader">
        <div>
          <h2 className="text-base">Earnings</h2>
          <p className="muted">Source: Yahoo Finance.</p>
        </div>
      </div>

      {hasForecast && (
        <div className="mt-3 grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2 lg:grid-cols-4">
          {overview.nextEarningsDate && (
            <Field
              label="Next earnings"
              value={`${overview.nextEarningsDate}${overview.nextEarningsIsEstimate ? ' (est)' : ''}`}
              sub={upcoming?.label}
            />
          )}
          {overview.earningsEpsAvg != null && (
            <Field
              label="EPS estimate"
              value={formatEps(overview.earningsEpsAvg, reportCurrency)}
              sub={
                overview.earningsEpsLow != null && overview.earningsEpsHigh != null
                  ? `${formatEps(overview.earningsEpsLow, reportCurrency)} – ${formatEps(overview.earningsEpsHigh, reportCurrency)}`
                  : undefined
              }
            />
          )}
          {overview.earningsRevenueAvg != null && (
            <Field
              label="Revenue estimate"
              value={formatRevenue(overview.earningsRevenueAvg, reportCurrency)}
              sub={
                overview.earningsRevenueLow != null && overview.earningsRevenueHigh != null
                  ? `${formatRevenue(overview.earningsRevenueLow, reportCurrency)} – ${formatRevenue(overview.earningsRevenueHigh, reportCurrency)}`
                  : undefined
              }
            />
          )}
        </div>
      )}

      {hasHistory && (
        <div className="mt-4">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
            Recent quarters
          </h3>
          <Table className="table">
            <TableHeader>
              <TableRow>
                <TableHead>Quarter</TableHead>
                <TableHead className="text-right">EPS actual</TableHead>
                <TableHead className="text-right">EPS estimate</TableHead>
                <TableHead className="text-right">Surprise</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {history.map((row, i) => {
                const surprise = row.surprisePercent
                return (
                  <TableRow key={`${row.quarter ?? row.period ?? i}`}>
                    <TableCell className="font-medium">{row.quarter ?? row.period ?? '—'}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatEps(row.epsActual, reportCurrency)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatEps(row.epsEstimate, reportCurrency)}
                    </TableCell>
                    <TableCell
                      className={
                        surprise != null && surprise > 0
                          ? 'text-right tabular-nums text-positive'
                          : surprise != null && surprise < 0
                            ? 'text-right tabular-nums text-warning'
                            : 'text-right tabular-nums'
                      }
                    >
                      {formatPercent(surprise)}
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </div>
      )}
    </Card>
  )
}

function Field({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="flex flex-col">
      <dt className="muted text-xs">{label}</dt>
      <dd className="font-medium">{value}</dd>
      {sub && <span className="muted text-xs mt-0.5">{sub}</span>}
    </div>
  )
}
