import { CalendarRange } from 'lucide-react'
import { formatCurrency } from '@/lib/formatCurrency'
import type { PeriodInsightCurrency } from '@cashflow/shared'

type Props = { data: PeriodInsightCurrency; currency: string; rangeLabel?: string }

/**
 * Period-scoped "this period at a glance" band. Two ideas only:
 *   1. the real-spend-vs-loaned split (what you actually consumed vs what
 *      comes back to you), and
 *   2. a "where the money moved this period" breakdown (spend / credits /
 *      income / payments).
 * Everything here is scoped to the selected window — no cross-period
 * comparison, no all-time outstanding stock, no per-category drill-down.
 */
export function PeriodInsightBand({ data, currency, rangeLabel }: Props) {
  // `currency` is '' when no currency filter is active; format with the row's
  // own currency so values still render as money, but keep the caption clean.
  const fmtCode = currency || data.currency
  const money = (n: number) => formatCurrency(n, fmtCode)

  const breakdown: Array<{ label: string; value: number }> = [
    { label: 'Spend', value: data.totalSpend },
    { label: 'Refunds / credits', value: data.totalCredits },
    { label: 'Income', value: data.totalIncome },
    { label: 'Payments / transfers', value: data.totalPayments },
  ]

  return (
    <div className="flex flex-col gap-4">
      {/* Caption */}
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <CalendarRange className="h-3.5 w-3.5" aria-hidden />
        {[rangeLabel || 'this period', currency].filter(Boolean).join(' · ')}
      </p>

      {/* Real-spend headline + loaned split */}
      <div className="flex flex-wrap items-end gap-x-4 gap-y-2">
        <div>
          <p className="text-sm text-muted-foreground">Real spend</p>
          <p className="text-[2rem] font-medium leading-tight tabular-nums">
            {money(data.realCost)}
          </p>
        </div>
        {data.owedBack > 0 && (
          <span className="mb-1 inline-flex w-fit items-center rounded-full bg-secondary/50 px-3 py-1 text-xs text-muted-foreground">
            +&nbsp;
            <span className="font-medium text-foreground">
              {money(data.owedBack)}
            </span>
            &nbsp;loaned out · comes back to you
          </span>
        )}
      </div>

      <hr className="border-border" />

      {/* Where the money moved this period */}
      <div className="flex flex-col gap-2">
        <p className="text-xs text-muted-foreground">
          Where the money moved this period
        </p>
        <div
          className="grid gap-3"
          style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))' }}
        >
          {breakdown.map((m) => (
            <div
              key={m.label}
              className="flex flex-col gap-1 rounded-md bg-secondary/50 p-3"
            >
              <span className="text-xs text-muted-foreground">{m.label}</span>
              <span className="text-xl tabular-nums">{money(m.value)}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
