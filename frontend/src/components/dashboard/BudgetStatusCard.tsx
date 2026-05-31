import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Skeleton } from '@/components/ui/skeleton'
import { Button } from '@/components/ui/button'
import { getJson } from '@/lib/api'
import { CategoryIcon } from '../CategoryIcon'
import { BentoTile } from './BentoTile'
import type { BudgetProgress, BudgetStatusResponse } from '@/types/api'
import { safePct } from '@/lib/num'

type Props = {
  /**
   * Defaults to 'CAD' so the card matches the rest of the dashboard's
   * currency filter. Passing `null` shows budgets across every currency in
   * the household (rare — most users have one currency).
   */
  currency?: string | null
}

/**
 * Dashboard "Budget status" card (issue #268). Lists every active budget
 * with a colored pill that reflects how far into the budget the user is:
 *   - green ("On track")  — under 80% spent
 *   - amber ("At risk")   — 80% to 100%
 *   - red   ("Over")      — past 100% (overspent)
 *
 * This card uses a simple spent-vs-target ratio — distinct from the
 * existing "Budget progress + pacing" tile which factors in elapsed time
 * via the backend's `pacingState`. The two views are intentionally
 * complementary: pacing tells you *how you're doing* relative to the
 * month's progress; status tells you *what threshold an alert would fire
 * at right now*, which mirrors the alert vocabulary from the daily breach
 * check (also at 80/100/120).
 *
 * Renders nothing when the user has no budgets configured — the empty state
 * lives on the Budgets settings tab; pushing a "you have no budgets" card
 * onto an already-busy dashboard adds noise without value.
 */
export function BudgetStatusCard({ currency = 'CAD' }: Props) {
  const [items, setItems] = useState<BudgetProgress[] | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    const qs = currency ? `?currency=${encodeURIComponent(currency)}` : ''
    ;(async () => {
      try {
        const resp = await getJson<BudgetStatusResponse>(
          `/api/budgets/status${qs}`,
        )
        if (!cancelled) setItems(resp.items)
      } catch {
        if (!cancelled) setItems([])
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [currency])

  // Empty / loading skeleton state.
  if (loading) {
    return (
      <BentoTile span={6} rows={1} label="Budget status" aria-busy>
        <div className="space-y-2" data-testid="budget-status-loading">
          <Skeleton className="h-6 w-full" />
          <Skeleton className="h-6 w-full" />
          <Skeleton className="h-6 w-full" />
        </div>
      </BentoTile>
    )
  }
  if (!items || items.length === 0) {
    return (
      <BentoTile span={6} rows={1} label="Budget status">
        <p className="muted text-sm mb-3">No budget targets set yet.</p>
        <Link to="/settings/budgets">
          <Button size="sm" variant="outline">Set a budget</Button>
        </Link>
      </BentoTile>
    )
  }

  return (
    <BentoTile
      span={6}
      rows={1}
      label="Budget status"
      description="Where each budget sits this period — at a glance."
    >
      <ul
        className="flex flex-col gap-2"
        data-testid="budget-status-list"
      >
        {items.map((item) => {
          const pct = item.percentUsed
          const finite = Number.isFinite(pct)
          // Status mirrors the alert vocabulary (80, 100). Anything past
          // 100 is "over"; anything at-or-past 80 is "at risk"; below is
          // "on track". Suppress status styling when pct is not finite.
          const status: 'ok' | 'risk' | 'over' = finite
            ? (pct >= 100 ? 'over' : pct >= 80 ? 'risk' : 'ok')
            : 'ok'
          // Lookup table for JIT-safe Tailwind classes — `status` is a
          // runtime string so we can't template the class names.
          const pillClass: Record<typeof status, string> = {
            ok: 'bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200',
            risk: 'bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200',
            over: 'bg-rose-100 text-rose-900 dark:bg-rose-950 dark:text-rose-200',
          }
          const pillLabel: Record<typeof status, string> = {
            ok: 'On track',
            risk: 'At risk',
            over: 'Over',
          }
          const label = item.category ?? 'Overall'
          return (
            <li
              key={item.budgetId}
              className="flex items-center justify-between gap-2"
              data-testid={`budget-status-row-${item.budgetId}`}
            >
              <span className="inline-flex items-center gap-1.5 min-w-0">
                <CategoryIcon name={item.category} />
                <span className="truncate">{label}</span>
              </span>
              <span className="inline-flex items-center gap-2 shrink-0">
                <span className="text-xs text-gray-500 dark:text-gray-400">
                  {finite ? `${Math.round(pct)}%` : safePct(pct)}
                </span>
                <span
                  className={`px-2 py-0.5 text-xs rounded-full ${finite ? pillClass[status] : ''}`}
                  data-testid={`budget-status-pill-${item.budgetId}`}
                >
                  {finite ? pillLabel[status] : '—'}
                </span>
              </span>
            </li>
          )
        })}
      </ul>
    </BentoTile>
  )
}
