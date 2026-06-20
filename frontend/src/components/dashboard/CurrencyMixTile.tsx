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
      span={12}
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
          {/* formerly .currencyMixBar */}
          <div
            className="mt-1 flex h-6 w-full overflow-hidden rounded-md border border-border"
            role="img"
            aria-label={`Currency mix: ${shares.map((s) => `${s.currency} ${Math.round(s.pct)} percent`).join(', ')}`}
          >
            {shares.map((s, i) => (
              // formerly .currencyMixBar__segment + sibling border-left
              <span
                key={s.currency}
                className="block h-full"
                style={{
                  width: `${s.pct}%`,
                  background: s.color,
                  transition: 'width 0.3s ease-out',
                  ...(i > 0
                    ? { borderLeft: '1px solid color-mix(in oklch, var(--card) 65%, transparent)' }
                    : {}),
                }}
              />
            ))}
          </div>
          {/* formerly .currencyMixLegend */}
          <ul className="m-0 mt-3 flex flex-col gap-1.5 p-0 list-none">
            {shares.map((s) => (
              // formerly .currencyMixLegend__row
              <li
                key={s.currency}
                className="grid items-center gap-2 text-xs"
                style={{ gridTemplateColumns: '10px auto 1fr auto' }}
              >
                {/* formerly .currencyMixLegend__dot */}
                <span
                  className="h-2.5 w-2.5 rounded-full"
                  style={{ background: s.color }}
                  aria-hidden="true"
                />
                {/* formerly .currencyMixLegend__code */}
                <span className="font-semibold text-foreground">{s.currency}</span>
                {/* formerly .currencyMixLegend__amount */}
                <span className="truncate text-right tabular-nums text-muted-foreground">
                  {formatMoney(s.value, s.currency)}
                </span>
                {/* formerly .currencyMixLegend__pct */}
                <span className="shrink-0 tabular-nums font-semibold text-foreground">
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
