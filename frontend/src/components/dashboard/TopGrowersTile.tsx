import { useMemo } from 'react'
import {
  DELTA_SIGN_STYLE,
  parseDeltaSign,
  resolveDeltaTone,
} from '@/components/ui/delta-tone'
import { BentoTile } from './BentoTile'
import { formatMoney } from '../../lib/formatMoney'

/** Minimal shape the tile depends on. CategoryReportRow conforms. */
type CategoryRow = {
  currency: string
  category: string | null
  netSpend: number
}

type GrowerRow = {
  key: string
  category: string
  currency: string
  current: number
  previous: number
  delta: number
  /** True when the category was absent in the previous period. */
  isNew: boolean
}

const UNCATEGORIZED = '(uncategorized)'
const MAX_ROWS = 5

type TopGrowersTileProps = {
  currentRows: CategoryRow[]
  previousRows: CategoryRow[]
  hasComparisonPeriod: boolean
  /** When non-empty, only this currency contributes; otherwise the tile
   *  rolls across all currencies in the supplied rows. */
  currency: string
  loading?: boolean
}

/**
 * Categories with the biggest absolute change vs the previous period.
 * Up = spend grew = bad (red); down = spend shrank = good (green).
 * Sort key is |delta| so a $1 → $100 jump doesn't outrank $500 → $1000.
 */
export function TopGrowersTile({
  currentRows,
  previousRows,
  hasComparisonPeriod,
  currency,
  loading,
}: TopGrowersTileProps) {
  const growers = useMemo<GrowerRow[]>(() => {
    if (!hasComparisonPeriod) return []
    const want = (r: CategoryRow): boolean => !currency || r.currency === currency

    const currentByKey = new Map<string, CategoryRow>()
    for (const r of currentRows) {
      if (!want(r)) continue
      const key = `${r.currency}:${r.category ?? UNCATEGORIZED}`
      currentByKey.set(key, r)
    }

    const previousByKey = new Map<string, CategoryRow>()
    for (const r of previousRows) {
      if (!want(r)) continue
      const key = `${r.currency}:${r.category ?? UNCATEGORIZED}`
      previousByKey.set(key, r)
    }

    const keys = new Set<string>([...currentByKey.keys(), ...previousByKey.keys()])
    const all: GrowerRow[] = []
    for (const key of keys) {
      const cur = currentByKey.get(key)
      const prev = previousByKey.get(key)
      const current = cur?.netSpend ?? 0
      const previousVal = prev?.netSpend ?? 0
      const delta = current - previousVal
      const rowCurrency = cur?.currency ?? prev?.currency ?? currency
      const category = cur?.category ?? prev?.category ?? UNCATEGORIZED
      all.push({
        key,
        category: category ?? UNCATEGORIZED,
        currency: rowCurrency,
        current,
        previous: previousVal,
        delta,
        isNew: !prev && Boolean(cur),
      })
    }
    return all
      .filter((g) => Math.abs(g.delta) > 0.005)
      .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
      .slice(0, MAX_ROWS)
  }, [currentRows, previousRows, currency, hasComparisonPeriod])

  return (
    <BentoTile
      span={6}
      rows={2}
      aria-busy={loading}
      label="Top growers"
      description="Categories with the biggest change vs previous period."
    >
      {!hasComparisonPeriod ? (
        <p className="emptyState">Set both dates for period comparison.</p>
      ) : growers.length === 0 ? (
        <p className="emptyState">No movement to highlight in this view.</p>
      ) : (
        <ul className="growersList">
          {growers.map((g) => {
            // The dashboard uses 'spend' semantics: more spend = bad.
            // We pass a signed delta-string so parseDeltaSign reads it
            // correctly, then resolveDeltaTone flips for 'spend'.
            const deltaLabel = `${g.delta >= 0 ? '+' : ''}${formatMoney(g.delta, g.currency)}`
            const sign = parseDeltaSign(deltaLabel)
            const tone = resolveDeltaTone(sign, 'spend')
            const pct =
              g.previous === 0
                ? null
                : Math.round((g.delta / Math.abs(g.previous)) * 100)
            return (
              <li key={g.key} className="growersList__row">
                <div className="growersList__main">
                  <span className="growersList__category" title={g.category}>
                    {g.category}
                  </span>
                  {g.isNew && <span className="growersList__newBadge">new</span>}
                </div>
                <span className="growersList__current">
                  {formatMoney(g.current, g.currency)}
                </span>
                <span
                  data-tone={tone}
                  className="growersList__delta inline-flex items-center rounded-md border px-1.5 py-0.5 text-xs font-semibold"
                  style={DELTA_SIGN_STYLE[tone]}
                >
                  {deltaLabel}
                  {pct !== null && (
                    <span className="ml-1 opacity-70">({pct > 0 ? '+' : ''}{pct}%)</span>
                  )}
                </span>
              </li>
            )
          })}
        </ul>
      )}
    </BentoTile>
  )
}
