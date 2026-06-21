import { useMemo } from 'react'
import { Link } from 'react-router-dom'
import { BentoTile } from './BentoTile'
import { formatMoney } from '../../lib/formatMoney'
import type { RecurringItem } from '../../types/api'

const MAX_ROWS = 5

type RecurringThisMonthTileProps = {
  items: RecurringItem[]
  loading?: boolean
}

/**
 * Recurring charges whose `nextExpected` falls inside the current
 * calendar month. Sorted by date ascending. Footer total runs across
 * all items hitting this month, not just the displayed top N.
 */
export function RecurringThisMonthTile({
  items,
  loading,
}: RecurringThisMonthTileProps) {
  const thisMonthKey = useMemo(() => {
    const now = new Date()
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
  }, [])

  const dueThisMonth = useMemo(() => {
    return items
      .filter((r) => typeof r.nextExpected === 'string' && r.nextExpected.startsWith(thisMonthKey))
      .slice()
      .sort((a, b) => a.nextExpected.localeCompare(b.nextExpected))
  }, [items, thisMonthKey])

  const totalsByCurrency = useMemo(() => {
    const m = new Map<string, number>()
    for (const r of dueThisMonth) {
      m.set(r.currency, (m.get(r.currency) ?? 0) + r.avgAmount)
    }
    return Array.from(m.entries()).sort(([a], [b]) => a.localeCompare(b))
  }, [dueThisMonth])

  return (
    <BentoTile
      span={6}
      rows={1}
      aria-busy={loading}
      label="Recurring this month"
      description="Subscriptions and recurring charges expected this calendar month."
    >
      {dueThisMonth.length === 0 ? (
        <p className="m-0 text-muted-foreground">
          {loading
            ? 'Loading recurring charges…'
            : 'No recurring charges expected this month.'}
        </p>
      ) : (
        <>
          {/* formerly .recurringList */}
          <ul className="m-0 flex flex-col gap-1.5 p-0 list-none">
            {dueThisMonth.slice(0, MAX_ROWS).map((r) => (
              // formerly .recurringList__row + sibling border-top
              <li
                key={`${r.merchant}:${r.currency}`}
                className="grid items-baseline gap-2 py-1 [&+&]:border-t [&+&]:border-border [&+&]:pt-2"
                style={{ gridTemplateColumns: 'minmax(0, 1fr) auto auto' }}
              >
                {/* formerly .recurringList__merchant + :hover */}
                <Link
                  to={`/transactions?merchant=${encodeURIComponent(r.merchant)}`}
                  className="truncate text-sm font-semibold no-underline text-foreground hover:text-primary hover:underline"
                  title={r.merchant}
                >
                  {r.merchant}
                </Link>
                {/* formerly .recurringList__amount */}
                <span className="text-sm tabular-nums text-foreground">
                  {formatMoney(r.avgAmount, r.currency)}
                </span>
                {/* formerly .recurringList__date */}
                <span className="text-xs tabular-nums text-muted-foreground">
                  {formatDueDate(r.nextExpected)}
                </span>
              </li>
            ))}
          </ul>
          {/* formerly .recurringList__footer */}
          <div
            className="mt-auto flex items-baseline justify-between gap-2 pt-2 text-xs border-t border-border"
          >
            {/* formerly .recurringList__total */}
            <span className="truncate tabular-nums text-muted-foreground">
              Total:{' '}
              {totalsByCurrency
                .map(([curr, sum]) => formatMoney(sum, curr))
                .join(' · ')}
            </span>
            {/* formerly .recurringList__viewAll + :hover */}
            <Link to="/recurring" className="shrink-0 font-semibold no-underline text-primary hover:underline">
              All recurring →
            </Link>
          </div>
        </>
      )}
    </BentoTile>
  )
}

/** Format "2026-05-28" as "May 28". Defensively returns the raw string
 *  if parsing fails so the tile never crashes on unexpected input. */
function formatDueDate(iso: string): string {
  const dt = new Date(`${iso}T00:00:00`)
  if (Number.isNaN(dt.getTime())) return iso
  return dt.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}
