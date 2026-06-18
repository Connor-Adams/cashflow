import { Card } from '@/components/ui/card'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import type { PortfolioSecurityOverview } from '../../types/api'
import { clampPct } from '../../lib/num'

export type FundFactsCardProps = {
  overview: PortfolioSecurityOverview | null
  currency: string
}

const SECTOR_LABELS: Record<string, string> = {
  realestate: 'Real Estate',
  consumer_cyclical: 'Consumer Cyclical',
  consumer_defensive: 'Consumer Defensive',
  basic_materials: 'Basic Materials',
  technology: 'Technology',
  communication_services: 'Communication',
  financial_services: 'Financial',
  utilities: 'Utilities',
  industrials: 'Industrials',
  energy: 'Energy',
  healthcare: 'Healthcare',
}

function formatPercent(fraction: number): string {
  const pct = fraction * 100
  const digits = Math.abs(pct) >= 100 ? 0 : pct >= 10 ? 1 : 2
  return `${pct.toFixed(digits)}%`
}

function formatCompactNumber(value: number, currencyCode?: string): string {
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
      const formatted = new Intl.NumberFormat(undefined, {
        style: 'currency',
        currency: currencyCode.toUpperCase(),
        maximumFractionDigits: digits,
        minimumFractionDigits: 0,
      }).format(Math.abs(scaled))
      const sign = scaled < 0 ? '-' : ''
      return `${sign}${formatted}${suffix}`
    } catch {
      return `${scaled.toFixed(digits)}${suffix} ${currencyCode}`
    }
  }
  return `${scaled.toFixed(digits)}${suffix}`
}

export function FundFactsCard({ overview, currency }: FundFactsCardProps) {
  if (!overview) return null

  const hasFundSignal =
    overview.fundFamily != null ||
    overview.fundCategory != null ||
    overview.fundLegalType != null ||
    overview.fundExpenseRatio != null ||
    overview.fundTotalAssets != null ||
    (overview.topHoldings != null && overview.topHoldings.length > 0) ||
    overview.sectorWeightings != null ||
    overview.stockPosition != null ||
    overview.bondPosition != null

  if (!hasFundSignal) return null

  const allocations = buildAllocations(overview)
  const sectors = buildSectorRows(overview.sectorWeightings)
  const holdings = (overview.topHoldings ?? []).filter((h) => h.percent != null || h.name != null).slice(0, 10)
  const returns = buildReturns(overview)
  const reportCurrency = (overview.financialCurrency ?? currency).toUpperCase()

  return (
    <Card>
      <div className="transactionsPanelHeader">
        <div>
          <h2 className="text-base">Fund facts</h2>
          <p className="muted">
            {overview.fundLegalType ?? 'Fund'} · Source: Yahoo Finance.
          </p>
        </div>
      </div>

      <dl className="mt-3 grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2 lg:grid-cols-4">
        {overview.fundFamily && (
          <FactRow label="Family" value={overview.fundFamily} />
        )}
        {overview.fundCategory && (
          <FactRow label="Category" value={overview.fundCategory} />
        )}
        {overview.fundExpenseRatio != null && (
          <FactRow label="Expense ratio" value={formatPercent(overview.fundExpenseRatio)} />
        )}
        {overview.fundTotalAssets != null && (
          <FactRow
            label="Net assets"
            value={formatCompactNumber(overview.fundTotalAssets, reportCurrency)}
          />
        )}
        {overview.fundYield != null && (
          <FactRow label="Yield" value={formatPercent(overview.fundYield)} />
        )}
      </dl>

      {allocations.length > 0 && (
        <div className="mt-4">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
            Asset allocation
          </h3>
          <AllocationBar rows={allocations} />
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs">
            {allocations.map((row) => (
              <div key={row.label} className="flex items-center gap-1.5">
                <span
                  className="inline-block size-2.5 rounded-sm"
                  style={{ background: row.color }}
                />
                <span className="muted">{row.label}</span>
                <span className="font-medium tabular-nums">{formatPercent(row.fraction)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {sectors.length > 0 && (
        <div className="mt-4">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
            Sector weightings
          </h3>
          <ul className="space-y-1.5">
            {sectors.map((row) => (
              <li key={row.key} className="grid grid-cols-[140px_1fr_auto] items-center gap-2 text-xs">
                <span className="muted truncate">{row.label}</span>
                <div className="h-2 rounded-full bg-muted overflow-hidden">
                  <div
                    className="h-full rounded-full"
                    style={{
                      width: `${Math.min(100, row.fraction * 100)}%`,
                      background: 'var(--chart-line-1)',
                    }}
                  />
                </div>
                <span className="font-medium tabular-nums text-right">{formatPercent(row.fraction)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {holdings.length > 0 && (
        <div className="mt-4">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
            Top holdings
          </h3>
          <Table className="[&_thead_th]:bg-[color-mix(in_srgb,var(--bg3)_72%,transparent)]">
            <TableHeader>
              <TableRow>
                <TableHead>Symbol</TableHead>
                <TableHead>Holding</TableHead>
                <TableHead className="text-right">% of fund</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {holdings.map((h, i) => (
                <TableRow key={`${h.symbol ?? h.name ?? i}`}>
                  <TableCell className="font-medium">{h.symbol ?? '—'}</TableCell>
                  <TableCell className="muted">{h.name ?? '—'}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {h.percent != null ? formatPercent(h.percent) : '—'}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {returns.length > 0 && (
        <div className="mt-4">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
            Trailing returns
          </h3>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-1.5 text-sm sm:grid-cols-5">
            {returns.map((r) => (
              <div key={r.label} className="flex flex-col">
                <dt className="muted text-xs">{r.label}</dt>
                <dd
                  className="font-medium tabular-nums"
                  data-positive={r.value > 0 ? 'true' : undefined}
                  data-negative={r.value < 0 ? 'true' : undefined}
                  style={{
                    color:
                      r.value > 0
                        ? 'var(--accent-positive)'
                        : r.value < 0
                          ? 'var(--accent-warm)'
                          : undefined,
                  }}
                >
                  {formatPercent(r.value)}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      )}

    </Card>
  )
}

function FactRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col">
      <dt className="muted text-xs">{label}</dt>
      <dd className="font-medium">{value}</dd>
    </div>
  )
}

type AllocationRow = { label: string; fraction: number; color: string }

function buildAllocations(o: PortfolioSecurityOverview): AllocationRow[] {
  const rows: AllocationRow[] = []
  if (o.stockPosition != null && o.stockPosition > 0)
    rows.push({ label: 'Stocks', fraction: o.stockPosition, color: 'var(--chart-line-1)' })
  if (o.bondPosition != null && o.bondPosition > 0)
    rows.push({ label: 'Bonds', fraction: o.bondPosition, color: 'var(--chart-line-2)' })
  if (o.cashPosition != null && o.cashPosition > 0)
    rows.push({ label: 'Cash', fraction: o.cashPosition, color: 'var(--accent-positive)' })
  return rows
}

function AllocationBar({ rows }: { rows: AllocationRow[] }) {
  const total = rows.reduce((s, r) => s + r.fraction, 0)
  if (total <= 0) return null
  return (
    <div className="flex h-3 w-full overflow-hidden rounded-full bg-muted">
      {rows.map((row) => (
        <div
          key={row.label}
          style={{
            width: `${clampPct((row.fraction / total) * 100)}%`,
            background: row.color,
          }}
          title={`${row.label}: ${formatPercent(row.fraction)}`}
        />
      ))}
    </div>
  )
}

type SectorRow = { key: string; label: string; fraction: number }

function buildSectorRows(weightings: Record<string, number> | null): SectorRow[] {
  if (!weightings) return []
  const rows: SectorRow[] = []
  for (const [key, fraction] of Object.entries(weightings)) {
    if (fraction <= 0) continue
    rows.push({ key, label: SECTOR_LABELS[key] ?? prettifyKey(key), fraction })
  }
  rows.sort((a, b) => b.fraction - a.fraction)
  return rows
}

function prettifyKey(k: string): string {
  return k
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
}

type ReturnRow = { label: string; value: number }

function buildReturns(o: PortfolioSecurityOverview): ReturnRow[] {
  const rows: ReturnRow[] = []
  if (o.trailingReturnYtd != null) rows.push({ label: 'YTD', value: o.trailingReturnYtd })
  if (o.trailingReturn1y != null) rows.push({ label: '1 year', value: o.trailingReturn1y })
  if (o.trailingReturn3y != null) rows.push({ label: '3 year', value: o.trailingReturn3y })
  if (o.trailingReturn5y != null) rows.push({ label: '5 year', value: o.trailingReturn5y })
  if (o.trailingReturn10y != null) rows.push({ label: '10 year', value: o.trailingReturn10y })
  return rows
}
