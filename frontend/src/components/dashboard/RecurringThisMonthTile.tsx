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
      rows={2}
      aria-busy={loading}
      label="Recurring this month"
      description="Subscriptions and recurring charges expected this calendar month."
    >
      {dueThisMonth.length === 0 ? (
        <p className="emptyState">
          {loading
            ? 'Loading recurring charges…'
            : 'No recurring charges expected this month.'}
        </p>
      ) : (
        <>
          <ul className="recurringList">
            {dueThisMonth.slice(0, MAX_ROWS).map((r) => (
              <li key={`${r.merchant}:${r.currency}`} className="recurringList__row">
                <Link
                  to={`/transactions?merchant=${encodeURIComponent(r.merchant)}`}
                  className="recurringList__merchant"
                  title={r.merchant}
                >
                  {r.merchant}
                </Link>
                <span className="recurringList__amount">
                  {formatMoney(r.avgAmount, r.currency)}
                </span>
                <span className="recurringList__date">
                  {formatDueDate(r.nextExpected)}
                </span>
              </li>
            ))}
          </ul>
          <div className="recurringList__footer">
            <span className="recurringList__total">
              Total:{' '}
              {totalsByCurrency
                .map(([curr, sum]) => formatMoney(sum, curr))
                .join(' · ')}
            </span>
            <Link to="/recurring" className="recurringList__viewAll">
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
