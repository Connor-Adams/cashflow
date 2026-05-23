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
const NOISE_THRESHOLD = 0.005

function rowKey(r: CategoryRow): string {
  return `${r.currency}:${r.category ?? UNCATEGORIZED}`
}

/**
 * Index a row list by `currency:category` key, filtered to the active
 * currency (or all currencies when `currency` is empty).
 */
function indexByKey(
  rows: CategoryRow[],
  currency: string
): Map<string, CategoryRow> {
  const out = new Map<string, CategoryRow>()
  for (const r of rows) {
    if (currency && r.currency !== currency) continue
    out.set(rowKey(r), r)
  }
  return out
}

/**
 * Build a GrowerRow for one (current?, previous?) pair. Either may be
 * undefined when the category exists only in one period.
 */
function makeGrower(
  key: string,
  current: CategoryRow | undefined,
  previous: CategoryRow | undefined,
  fallbackCurrency: string
): GrowerRow {
  const currentVal = current?.netSpend ?? 0
  const previousVal = previous?.netSpend ?? 0
  return {
    key,
    category: current?.category ?? previous?.category ?? UNCATEGORIZED,
    currency: current?.currency ?? previous?.currency ?? fallbackCurrency,
    current: currentVal,
    previous: previousVal,
    delta: currentVal - previousVal,
    isNew: !previous && Boolean(current),
  }
}

/**
 * Sort key for ranking: absolute delta descending. Categories with
 * tiny differences (< NOISE_THRESHOLD) are dropped before sorting.
 */
function computeGrowers(
  currentRows: CategoryRow[],
  previousRows: CategoryRow[],
  currency: string
): GrowerRow[] {
  const currentByKey = indexByKey(currentRows, currency)
  const previousByKey = indexByKey(previousRows, currency)
  const allKeys = new Set<string>([
    ...currentByKey.keys(),
    ...previousByKey.keys(),
  ])
  const rows: GrowerRow[] = []
  for (const key of allKeys) {
    rows.push(
      makeGrower(key, currentByKey.get(key), previousByKey.get(key), currency)
    )
  }
  return rows
    .filter((g) => Math.abs(g.delta) > NOISE_THRESHOLD)
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
}

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
  const growers = useMemo<GrowerRow[]>(
    () =>
      hasComparisonPeriod
        ? computeGrowers(currentRows, previousRows, currency).slice(0, MAX_ROWS)
        : [],
    [currentRows, previousRows, currency, hasComparisonPeriod]
  )

  return (
    <BentoTile
      span={6}
      rows={2}
      aria-busy={loading}
      label="Top growers"
      description="Categories with the biggest change vs previous period."
    >
      <GrowersBody hasComparisonPeriod={hasComparisonPeriod} growers={growers} />
    </BentoTile>
  )
}

function GrowersBody({
  hasComparisonPeriod,
  growers,
}: {
  hasComparisonPeriod: boolean
  growers: GrowerRow[]
}) {
  if (!hasComparisonPeriod) {
    return <p className="emptyState">Set both dates for period comparison.</p>
  }
  if (growers.length === 0) {
    return <p className="emptyState">No movement to highlight in this view.</p>
  }
  return (
    <ul className="growersList">
      {growers.map((g) => (
        <GrowerListItem key={g.key} grower={g} />
      ))}
    </ul>
  )
}

function GrowerListItem({ grower }: { grower: GrowerRow }) {
  // The dashboard uses 'spend' semantics: more spend = bad. Pass a signed
  // delta string so parseDeltaSign reads it correctly, then resolveDeltaTone
  // flips for 'spend'.
  const deltaLabel = formatSignedMoney(grower.delta, grower.currency)
  const tone = resolveDeltaTone(parseDeltaSign(deltaLabel), 'spend')
  const pct = computePercent(grower)
  return (
    <li className="growersList__row">
      <div className="growersList__main">
        <span className="growersList__category" title={grower.category}>
          {grower.category}
        </span>
        {grower.isNew && <span className="growersList__newBadge">new</span>}
      </div>
      <span className="growersList__current">
        {formatMoney(grower.current, grower.currency)}
      </span>
      <span
        data-tone={tone}
        className="growersList__delta inline-flex items-center rounded-md border px-1.5 py-0.5 text-xs font-semibold"
        style={DELTA_SIGN_STYLE[tone]}
      >
        {deltaLabel}
        {pct !== null && <PercentSuffix pct={pct} />}
      </span>
    </li>
  )
}

function PercentSuffix({ pct }: { pct: number }) {
  const prefix = pct > 0 ? '+' : ''
  return (
    <span className="ml-1 opacity-70">
      ({prefix}{pct}%)
    </span>
  )
}

function formatSignedMoney(amount: number, currency: string): string {
  const prefix = amount >= 0 ? '+' : ''
  return `${prefix}${formatMoney(amount, currency)}`
}

function computePercent(g: GrowerRow): number | null {
  if (g.previous === 0) return null
  return Math.round((g.delta / Math.abs(g.previous)) * 100)
}
