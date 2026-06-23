import { Icon } from '@connor-adams/designsystem'
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

  // Semantic tint per money-movement bucket: out=oxblood, in=green, neutral=info.
  const TONE: Record<string, { tile: string; value: string }> = {
    Spend: { tile: 'bg-negative-bg', value: 'text-negative' },
    'Refunds / credits': { tile: 'bg-success-bg', value: 'text-positive' },
    Income: { tile: 'bg-success-bg', value: 'text-positive' },
    'Payments / transfers': { tile: 'bg-info-bg', value: 'text-info' },
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Caption */}
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Icon name="calendar-range" className="h-3.5 w-3.5" aria-hidden />
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
          <span className="mb-1 inline-flex w-fit items-center rounded-full bg-success-bg px-3 py-1 text-xs text-positive">
            +&nbsp;
            <span className="font-medium">
              {money(data.owedBack)}
            </span>
            &nbsp;loaned out · comes back to you
          </span>
        )}
      </div>

      {(data.peerLending.lent > 0 || data.peerLending.received > 0) && (
        <div className="flex flex-wrap gap-3">
          {data.peerLending.lent > 0 && (
            <div className="flex flex-col gap-1 rounded-md bg-negative-bg p-3">
              <span className="text-xs text-muted-foreground">Lent out</span>
              <span className="text-xl font-semibold tabular-nums text-negative">
                {money(data.peerLending.lent)}
              </span>
            </div>
          )}
          {data.peerLending.received > 0 && (
            <div className="flex flex-col gap-1 rounded-md bg-success-bg p-3">
              <span className="text-xs text-muted-foreground">Received back</span>
              <span className="text-xl font-semibold tabular-nums text-positive">
                {money(data.peerLending.received)}
              </span>
            </div>
          )}
        </div>
      )}

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
          {breakdown.map((m) => {
            const tone = TONE[m.label] ?? { tile: 'bg-secondary/50', value: '' }
            return (
              <div
                key={m.label}
                className={`flex flex-col gap-1 rounded-md p-3 ${tone.tile}`}
              >
                <span className="text-xs text-muted-foreground">{m.label}</span>
                <span className={`text-xl font-semibold tabular-nums ${tone.value}`}>
                  {money(m.value)}
                </span>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
