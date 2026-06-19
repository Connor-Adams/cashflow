import { Card } from '@cashflow/ui'
import { formatMoney } from '../../lib/formatMoney'
import type { PortfolioSecurityOverview } from '../../types/api'

export type MarketDataCardProps = {
  overview: PortfolioSecurityOverview | null
  /** Listing currency, used to format money fields when overview lacks `financialCurrency`. */
  currency: string
}

const RECOMMENDATION_LABELS: Record<string, string> = {
  strong_buy: 'Strong Buy',
  buy: 'Buy',
  outperform: 'Outperform',
  hold: 'Hold',
  underperform: 'Underperform',
  sell: 'Sell',
  strong_sell: 'Strong Sell',
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
  const body = scaled.toFixed(digits)
  if (currencyCode) {
    try {
      const formatted = new Intl.NumberFormat('en-CA', {
        style: 'currency',
        currency: currencyCode.toUpperCase(),
        maximumFractionDigits: digits,
        minimumFractionDigits: 0,
      }).format(Math.abs(scaled))
      const sign = scaled < 0 ? '-' : ''
      return `${sign}${formatted}${suffix}`
    } catch {
      return `${body}${suffix} ${currencyCode}`
    }
  }
  return `${body}${suffix}`
}

function formatPercent(value: number, fromFraction = true): string {
  const pct = fromFraction ? value * 100 : value
  const digits = Math.abs(pct) >= 100 ? 0 : 2
  return `${pct.toFixed(digits)}%`
}

function formatMultiple(value: number): string {
  return `${value.toFixed(2)}×`
}

function formatRecommendation(key: string | null, mean: number | null, count: number | null): string | null {
  if (!key && mean == null) return null
  const label = key ? RECOMMENDATION_LABELS[key] ?? key.replace(/_/g, ' ') : null
  const parts: string[] = []
  if (label) parts.push(label)
  if (mean != null) parts.push(`(${mean.toFixed(2)})`)
  if (count != null) parts.push(`· ${count} analysts`)
  return parts.length === 0 ? null : parts.join(' ')
}

function formatVolume(value: number): string {
  return formatCompactNumber(value).replace(/\.00$/, '')
}

function formatPriceRange(low: number | null, high: number | null, currency: string): string | null {
  if (low == null || high == null) return null
  return `${formatMoney(low, currency)} – ${formatMoney(high, currency)}`
}

type StatRow = { label: string; value: string }

export function MarketDataCard({ overview, currency }: MarketDataCardProps) {
  if (!overview) {
    return (
      <Card>
        <h2 className="text-base">Market data</h2>
        <p className="muted">No market data available yet.</p>
      </Card>
    )
  }

  const fc = overview.financialCurrency ?? currency
  const fxCurrency = fc.toUpperCase()

  const market: StatRow[] = []
  if (overview.marketCap != null) market.push({ label: 'Market cap', value: formatCompactNumber(overview.marketCap, fxCurrency) })
  if (overview.trailingPE != null) market.push({ label: 'P/E (trailing)', value: formatMultiple(overview.trailingPE) })
  if (overview.forwardPE != null) market.push({ label: 'P/E (forward)', value: formatMultiple(overview.forwardPE) })
  if (overview.trailingEps != null) market.push({ label: 'EPS (trailing)', value: formatMoney(overview.trailingEps, fxCurrency) })
  if (overview.forwardEps != null) market.push({ label: 'EPS (forward)', value: formatMoney(overview.forwardEps, fxCurrency) })
  if (overview.beta != null) market.push({ label: 'Beta', value: overview.beta.toFixed(2) })
  if (overview.priceToBook != null) market.push({ label: 'Price / book', value: formatMultiple(overview.priceToBook) })
  const dayRange = formatPriceRange(overview.dayLow, overview.dayHigh, currency)
  if (dayRange) market.push({ label: 'Day range', value: dayRange })
  if (overview.volume != null) market.push({ label: 'Volume', value: formatVolume(overview.volume) })
  if (overview.averageVolume != null) market.push({ label: 'Avg volume', value: formatVolume(overview.averageVolume) })
  if (overview.fiftyDayAverage != null) market.push({ label: '50-day avg', value: formatMoney(overview.fiftyDayAverage, currency) })
  if (overview.twoHundredDayAverage != null) market.push({ label: '200-day avg', value: formatMoney(overview.twoHundredDayAverage, currency) })
  if (overview.sharesOutstanding != null) market.push({ label: 'Shares outstanding', value: formatCompactNumber(overview.sharesOutstanding) })

  const dividends: StatRow[] = []
  if (overview.dividendYield != null) dividends.push({ label: 'Dividend yield', value: formatPercent(overview.dividendYield) })
  if (overview.dividendRate != null) dividends.push({ label: 'Dividend rate', value: formatMoney(overview.dividendRate, fxCurrency) })
  if (overview.fiveYearAvgDividendYield != null) dividends.push({ label: '5y avg yield', value: formatPercent(overview.fiveYearAvgDividendYield, false) })
  if (overview.payoutRatio != null) dividends.push({ label: 'Payout ratio', value: formatPercent(overview.payoutRatio) })
  if (overview.exDividendDate) dividends.push({ label: 'Ex-dividend', value: overview.exDividendDate })

  const fundamentals: StatRow[] = []
  if (overview.totalRevenue != null) fundamentals.push({ label: 'Revenue (TTM)', value: formatCompactNumber(overview.totalRevenue, fxCurrency) })
  if (overview.revenuePerShare != null) fundamentals.push({ label: 'Revenue / share', value: formatMoney(overview.revenuePerShare, fxCurrency) })
  if (overview.profitMargins != null) fundamentals.push({ label: 'Profit margin', value: formatPercent(overview.profitMargins) })
  if (overview.grossMargins != null) fundamentals.push({ label: 'Gross margin', value: formatPercent(overview.grossMargins) })
  if (overview.operatingMargins != null) fundamentals.push({ label: 'Operating margin', value: formatPercent(overview.operatingMargins) })
  if (overview.ebitdaMargins != null) fundamentals.push({ label: 'EBITDA margin', value: formatPercent(overview.ebitdaMargins) })
  if (overview.returnOnEquity != null) fundamentals.push({ label: 'Return on equity', value: formatPercent(overview.returnOnEquity) })
  if (overview.returnOnAssets != null) fundamentals.push({ label: 'Return on assets', value: formatPercent(overview.returnOnAssets) })
  if (overview.totalCash != null) fundamentals.push({ label: 'Total cash', value: formatCompactNumber(overview.totalCash, fxCurrency) })
  if (overview.totalDebt != null) fundamentals.push({ label: 'Total debt', value: formatCompactNumber(overview.totalDebt, fxCurrency) })
  if (overview.debtToEquity != null) fundamentals.push({ label: 'Debt / equity', value: overview.debtToEquity.toFixed(2) })
  if (overview.freeCashflow != null) fundamentals.push({ label: 'Free cash flow', value: formatCompactNumber(overview.freeCashflow, fxCurrency) })
  if (overview.operatingCashflow != null) fundamentals.push({ label: 'Operating cash flow', value: formatCompactNumber(overview.operatingCashflow, fxCurrency) })

  const analyst: StatRow[] = []
  const rec = formatRecommendation(overview.recommendationKey, overview.recommendationMean, overview.numberOfAnalystOpinions)
  if (rec) analyst.push({ label: 'Recommendation', value: rec })
  if (overview.targetMeanPrice != null) analyst.push({ label: 'Target (mean)', value: formatMoney(overview.targetMeanPrice, currency) })
  if (overview.targetHighPrice != null) analyst.push({ label: 'Target (high)', value: formatMoney(overview.targetHighPrice, currency) })
  if (overview.targetLowPrice != null) analyst.push({ label: 'Target (low)', value: formatMoney(overview.targetLowPrice, currency) })

  const supply: StatRow[] = []
  if (overview.circulatingSupply != null) supply.push({ label: 'Circulating supply', value: formatCompactNumber(overview.circulatingSupply) })
  if (overview.volume24Hr != null) supply.push({ label: '24h volume', value: formatCompactNumber(overview.volume24Hr, fxCurrency) })
  if (overview.cryptoStartDate) supply.push({ label: 'Started', value: overview.cryptoStartDate })

  const allEmpty =
    market.length === 0 &&
    dividends.length === 0 &&
    fundamentals.length === 0 &&
    analyst.length === 0 &&
    supply.length === 0 &&
    overview.fiftyTwoWeekLow == null &&
    overview.fiftyTwoWeekHigh == null

  if (allEmpty) {
    return (
      <Card>
        <h2 className="text-base">Market data</h2>
        <p className="muted">No market data available for this security.</p>
      </Card>
    )
  }

  return (
    <Card>
      <div className="transactionsPanelHeader">
        <div>
          <h2 className="text-base">Market data</h2>
          <p className="muted">Source: Yahoo Finance.</p>
        </div>
      </div>

      <FiftyTwoWeekRange
        low={overview.fiftyTwoWeekLow}
        high={overview.fiftyTwoWeekHigh}
        current={overview.regularMarketPrice}
        previousClose={overview.previousClose}
        currency={currency}
      />

      <div className="mt-4 grid gap-x-6 gap-y-4 sm:grid-cols-2 lg:grid-cols-4">
        {market.length > 0 && <StatGroup title="Market" rows={market} />}
        {supply.length > 0 && <StatGroup title="Supply" rows={supply} />}
        {dividends.length > 0 && <StatGroup title="Dividends" rows={dividends} />}
        {fundamentals.length > 0 && <StatGroup title="Fundamentals" rows={fundamentals} />}
        {analyst.length > 0 && <StatGroup title="Analysts" rows={analyst} />}
      </div>

      {overview.financialCurrency && overview.financialCurrency.toUpperCase() !== currency.toUpperCase() && (
        <p className="muted text-xs mt-3">
          Fundamentals reported in {overview.financialCurrency.toUpperCase()}; price in {currency.toUpperCase()}.
        </p>
      )}
    </Card>
  )
}

function StatGroup({ title, rows }: { title: string; rows: StatRow[] }) {
  return (
    <div>
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
        {title}
      </h3>
      <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1.5 text-sm">
        {rows.map((row) => (
          <div key={row.label} className="contents">
            <dt className="muted">{row.label}</dt>
            <dd className="font-medium tabular-nums text-right">{row.value}</dd>
          </div>
        ))}
      </dl>
    </div>
  )
}

function FiftyTwoWeekRange({
  low,
  high,
  current,
  previousClose,
  currency,
}: {
  low: number | null
  high: number | null
  current: number | null
  previousClose: number | null
  currency: string
}) {
  if (low == null || high == null || high <= low) return null
  const price = current ?? previousClose
  if (price == null) {
    return (
      <div className="mt-3">
        <div className="flex justify-between text-xs muted mb-1">
          <span>52-week low {formatMoney(low, currency)}</span>
          <span>52-week high {formatMoney(high, currency)}</span>
        </div>
        <div className="h-2 rounded-full bg-muted" />
      </div>
    )
  }
  const pct = Math.max(0, Math.min(1, (price - low) / (high - low))) * 100
  return (
    <div className="mt-3">
      <div className="flex justify-between text-xs muted mb-1">
        <span>52w low {formatMoney(low, currency)}</span>
        <span className="font-medium text-foreground">{formatMoney(price, currency)}</span>
        <span>52w high {formatMoney(high, currency)}</span>
      </div>
      <div className="relative h-2 rounded-full bg-muted overflow-visible">
        <div
          className="h-full rounded-full"
          style={{
            width: `${pct}%`,
            background: 'var(--chart-line-1)',
          }}
        />
        <div
          className="absolute top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-background"
          style={{
            left: `${pct}%`,
            background: 'var(--chart-line-1)',
          }}
        />
      </div>
    </div>
  )
}
