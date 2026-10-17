import { formatCurrency } from '@/lib/formatCurrency'

type Props = {
  /**
   * `BudgetProgress.carriedIn` — the signed remainder rolled in from the
   * budget's completed prior periods. Positive is unspent surplus, negative is
   * an overspend carried forward as a reduction. 0 (or absent) when the budget
   * has rollover off, which renders nothing.
   */
  carriedIn: number | null | undefined
  currency: string
  /** 'week' | 'month' | 'year', matching the budget's period. */
  periodWord: string
}

/**
 * The one-line explanation under a budget row's "spent / target" figures when
 * rollover has moved the target.
 *
 * Without it a carry-adjusted target reads as though the user had silently
 * edited their budget — the row would just show a number that isn't the amount
 * they set. Naming the carry is what makes the headline figure explicable.
 *
 * Its own component rather than an inline block because the dashboard's budget
 * row callback is already one of the most complex functions in the codebase;
 * inlining the branching pushed it from a "high" to a "critical" complexity
 * finding.
 *
 * Renders nothing for a sub-cent carry — floating-point dust from the prorated
 * creation period is noise, not information.
 */
export function BudgetCarryNote({ carriedIn, currency, periodWord }: Props) {
  const amount = Number(carriedIn ?? 0)
  if (!Number.isFinite(amount) || Math.abs(amount) < 0.01) return null
  const surplus = amount > 0
  const formatted = formatCurrency(Math.abs(amount), currency)
  return (
    <p className="m-0 truncate text-xs text-muted-foreground opacity-80">
      {surplus
        ? `includes +${formatted} rolled over from last ${periodWord}`
        : `−${formatted} overspent last ${periodWord}`}
    </p>
  )
}
