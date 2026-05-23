import { useMemo } from 'react'
import { BentoTile } from './BentoTile'
import { formatMoney } from '../../lib/formatMoney'

/** Minimal shape — CurrencyMetrics conforms. */
type Metric = {
  currency: string
  netSpend: number
}

type CurrencyMixTileProps = {
  metrics: Metric[]
  loading?: boolean
}

const LINE_TOKENS = [
  'var(--chart-line-1)',
  'var(--chart-line-2)',
  'var(--chart-line-3)',
  'var(--chart-line-4)',
  'var(--chart-line-5)',
  'var(--chart-line-6)',
]

/**
 * Share of net spend across currencies the user has activity in. Sources
 * the raw metrics array unfiltered by the dashboard's currency picker —
 * intentionally a global-exposure view, not a per-currency drill.
 */
export function CurrencyMixTile({ metrics, loading }: CurrencyMixTileProps) {
  const shares = useMemo(() => {
    // Use absolute net spend so currencies with negative net (refund-heavy
    // periods) still contribute proportionally rather than canceling out.
    const rows = metrics
      .map((m) => ({ currency: m.currency, value: Math.abs(m.netSpend) }))
      .filter((r) => r.value > 0)
      .sort((a, b) => b.value - a.value)
    const total = rows.reduce((s, r) => s + r.value, 0)
    if (total === 0) return []
    return rows.map((r, i) => ({
      ...r,
      pct: (r.value / total) * 100,
      color: LINE_TOKENS[i % LINE_TOKENS.length],
    }))
  }, [metrics])

  return (
    <BentoTile
      span={6}
      rows={2}
      aria-busy={loading}
      label="Currency mix"
      description="Share of net spend across all currencies in your data."
    >
      {shares.length < 2 ? (
        <p className="emptyState">
          Currency mix shows when you have transactions in 2+ currencies.
        </p>
      ) : (
        <>
          <div
            className="currencyMixBar"
            role="img"
            aria-label={`Currency mix: ${shares.map((s) => `${s.currency} ${Math.round(s.pct)} percent`).join(', ')}`}
          >
            {shares.map((s) => (
              <span
                key={s.currency}
                className="currencyMixBar__segment"
                style={{ width: `${s.pct}%`, background: s.color }}
              />
            ))}
          </div>
          <ul className="currencyMixLegend">
            {shares.map((s) => (
              <li key={s.currency} className="currencyMixLegend__row">
                <span
                  className="currencyMixLegend__dot"
                  style={{ background: s.color }}
                  aria-hidden="true"
                />
                <span className="currencyMixLegend__code">{s.currency}</span>
                <span className="currencyMixLegend__amount">
                  {formatMoney(s.value, s.currency)}
                </span>
                <span className="currencyMixLegend__pct">
                  {Math.round(s.pct)}%
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </BentoTile>
  )
}
