import { Link } from 'react-router-dom'
import { DeltaBadge } from '@/components/ui/DeltaBadge'
import { formatCurrency } from '@/lib/formatCurrency'
import type { PeriodInsightCurrency } from '@cashflow/shared'

type Props = { data: PeriodInsightCurrency; currency: string }

export function PeriodInsightBand({ data, currency }: Props) {
  const money = (n: number) => formatCurrency(n, currency)

  const baselines = data.baselines ?? []
  const movers = data.movers ?? []
  // Trend chips only for baselines that carry a comparable owed-back delta.
  const owedBackTrends = baselines.filter((b) => b.owedBackDeltaPct != null)

  return (
    <div className="flex flex-col gap-3">
      {/* Decomposition headline */}
      <div>
        <p className="text-sm text-muted-foreground">Real spend · this period</p>
        <p className="text-3xl font-semibold tabular-nums">{money(data.realCost)}</p>
        <p className="text-sm text-muted-foreground">
          {data.owedBack > 0 ? (
            <>loaned out {money(data.owedBack)} this period</>
          ) : (
            <>nothing loaned out this period</>
          )}
          {data.receivablesOutstanding > 0 && (
            <> · {money(data.receivablesOutstanding)} owed to you overall</>
          )}
        </p>
      </div>

      {/* Comparison + owed-back trend chips */}
      {(baselines.length > 0 || owedBackTrends.length > 0) && (
        <div className="flex flex-wrap items-center gap-2">
          {baselines.map((b) =>
            b.realCostDeltaPct != null ? (
              <span
                key={`real-${b.key}`}
                className="inline-flex items-center gap-1 text-xs text-muted-foreground"
              >
                vs {b.label}
                <DeltaBadge delta={b.realCostDeltaPct} metricKind="spend" />
              </span>
            ) : null,
          )}
          {owedBackTrends.map((b) => (
            <span
              key={`loaned-${b.key}`}
              className="inline-flex items-center gap-1 text-xs text-muted-foreground"
            >
              loaned vs {b.label}
              <DeltaBadge delta={b.owedBackDeltaPct as number} metricKind="neutral" />
            </span>
          ))}
        </div>
      )}

      {/* Movers */}
      {movers.length > 0 && (
        <ul className="flex flex-col gap-1">
          {movers.map((m) => (
            <li
              key={m.category}
              className="flex items-center justify-between gap-2 text-sm"
            >
              <Link
                to={`/transactions?category=${encodeURIComponent(m.category)}`}
                className="hover:underline"
              >
                {m.category}
              </Link>
              <span className="flex items-center gap-2 text-muted-foreground">
                {m.deltaPct != null && (
                  <DeltaBadge delta={m.deltaPct} metricKind="spend" />
                )}
                {m.driver.topMerchant && (
                  <span className="tabular-nums">
                    {m.driver.txnCount}× {m.driver.topMerchant}
                  </span>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
