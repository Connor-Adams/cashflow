import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Button } from '@cashflow/ui'
import { BentoTile } from './BentoTile'
import { useSafeToSpend } from '@/hooks/useSafeToSpend'
import { formatMoney } from '@/lib/formatMoney'

type Props = {
  /**
   * Defaults to 'CAD' to match the rest of the dashboard's currency filter.
   * Pass through whatever the dashboard's filter bar has currently selected
   * so the tile responds to the same control. Pass `null` to let the
   * backend pick the household's dominant cash currency.
   */
  currency?: string | null
}

type BreakdownRow = {
  label: string
  amount: number
  sign: '+' | '-'
  note?: string
}

/**
 * Dashboard tile (issue #199). Shows the user's "safe to spend" number for
 * the configured window, plus a collapsible breakdown that explains the
 * subtraction. Flips to a destructive variant when the value is negative —
 * a visual cue that the user is committed past their cash on hand for the
 * window.
 *
 * Currency-aware: the tile defers to whatever currency the dashboard is
 * filtered to. When the parent passes `currency={null}` the backend picks
 * the household's largest-cash currency (typically CAD).
 */
export function SafeToSpendTile({ currency = 'CAD' }: Props) {
  const [showBreakdown, setShowBreakdown] = useState(false)
  const safeToSpend = useSafeToSpend({ currency: currency ?? null })

  const data = safeToSpend.data
  const isNegative = data?.isNegative ?? false
  // Positive safe-to-spend is the dashboard's one deliberate gradient hero.
  const onGradient = !!data && !isNegative

  const rows: BreakdownRow[] = data
    ? [
        { label: 'Current cash', amount: data.breakdown.currentCash, sign: '+' },
        {
          label: 'Upcoming required expenses',
          amount: data.breakdown.upcomingRequiredExpenses,
          sign: '-',
          note: `next ${data.windowDays}d`,
        },
        {
          label: 'Required savings contributions',
          amount: data.breakdown.requiredSavingsContributions,
          sign: '-',
          note: data.settings.includeGoalContributions ? undefined : 'disabled',
        },
        {
          label: 'Expected credit-card payments',
          amount: data.breakdown.expectedCreditCardPayments,
          sign: '-',
          note: data.settings.includeCreditCardBalance ? undefined : 'disabled',
        },
        {
          label: 'Minimum cash buffer',
          amount: data.breakdown.minimumBuffer,
          sign: '-',
        },
      ]
    : []

  return (
    <BentoTile
      span={6}
      rows={2}
      variant={isNegative ? 'destructive' : 'gradient'}
      aria-busy={safeToSpend.loading}
      label="Safe to spend"
      description={
        data
          ? `${data.windowDays}-day window through ${data.windowEndDate}`
          : 'How much you can spend without dipping into required funds.'
      }
      actions={
        <Link
          to="/settings"
          className={
            onGradient
              ? 'text-xs font-semibold text-white/85 hover:text-white hover:underline'
              : 'text-xs font-semibold text-muted-foreground hover:text-foreground hover:underline'
          }
        >
          Settings
        </Link>
      }
    >
      {safeToSpend.loading && !data ? (
        <p className="text-sm text-muted-foreground">Loading safe-to-spend…</p>
      ) : safeToSpend.error ? (
        <p className="text-sm text-muted-foreground">
          {safeToSpend.error.message || 'Safe-to-spend unavailable.'}
        </p>
      ) : !data ? (
        <p className="text-sm text-muted-foreground">
          Set up an account to see your safe-to-spend.
        </p>
      ) : (
        <div className="space-y-3">
          <div>
            <div
              className={
                isNegative
                  ? 'text-4xl font-bold tabular-nums text-destructive'
                  : 'text-5xl font-extrabold tracking-tight tabular-nums'
              }
            >
              {formatMoney(data.value, data.currency)}
            </div>
            <div className={onGradient ? 'text-xs text-white/85' : 'text-xs text-muted-foreground'}>
              {isNegative
                ? 'You are committed past your cash on hand for this window. Trim a planned expense or raise more cash.'
                : `Safe to spend in ${data.currency} over the next ${data.windowDays} days.`}
            </div>
          </div>

          <Button
            type="button"
            variant="link"
            size="sm"
            className={onGradient ? 'text-white hover:text-white' : undefined}
            onClick={() => setShowBreakdown((s) => !s)}
            aria-expanded={showBreakdown}
          >
            {showBreakdown ? 'Hide breakdown' : 'Show breakdown'}
          </Button>

          {showBreakdown ? (
            <ul
              className={
                onGradient
                  ? 'space-y-1 rounded-md border border-white/20 bg-card p-2 text-sm text-foreground'
                  : 'space-y-1 rounded-md border border-border bg-muted/40 p-2 text-sm'
              }
            >
              {rows.map((row) => (
                <li
                  key={row.label}
                  className="flex items-baseline justify-between gap-2"
                >
                  <span className="text-muted-foreground">
                    {row.label}
                    {row.note ? (
                      <span className="ml-1 text-[10px] uppercase tracking-wide text-muted-foreground/70">
                        ({row.note})
                      </span>
                    ) : null}
                  </span>
                  <span className="shrink-0 tabular-nums">
                    {row.sign === '-' ? '−' : '+'}
                    {formatMoney(row.amount, data.currency)}
                  </span>
                </li>
              ))}
              <li className="mt-2 flex items-baseline justify-between gap-2 border-t border-border pt-2 font-semibold">
                <span>Safe to spend</span>
                <span className="shrink-0 tabular-nums">
                  {formatMoney(data.value, data.currency)}
                </span>
              </li>
            </ul>
          ) : null}
        </div>
      )}
    </BentoTile>
  )
}
