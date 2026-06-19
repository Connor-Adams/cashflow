import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Button } from '@cashflow/ui'
import { BentoTile } from './BentoTile'
import {
  useReceiptCompleteness,
  useMissingReceipts,
  type ReceiptCompletenessFilter,
} from '@/hooks/useReceiptCompleteness'
import { formatMoney } from '@/lib/formatMoney'

const FILTER_OPTIONS: { value: ReceiptCompletenessFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'business', label: 'Business' },
  { value: 'tax-relevant', label: 'Tax-relevant' },
]

function formatPercent(ratio: number): string {
  if (!Number.isFinite(ratio)) return '0%'
  return `${Math.round(ratio * 100)}%`
}

type Props = {
  /**
   * Defaults to 'CAD' to match the rest of the dashboard's
   * DEFAULT_DASHBOARD_CURRENCY. Pass through whatever the dashboard's filter
   * bar has currently selected so the tile responds to the same control.
   * Pass `null` to aggregate across all currencies.
   */
  currency?: string | null
}

/**
 * Dashboard tile (#209). Shows receipt coverage % by count and by absolute
 * dollar amount, the number of missing receipts, the total dollar value of
 * those missing receipts, and the top 3 largest unreceipted spend rows. The
 * filter chip toggles between All / Business / Tax-relevant; each click
 * refetches both the headline numbers and the top-missing list.
 *
 * Auto-refreshes on `cashflow:receipts-changed` window events — triggered by
 * the receipt upload + delete handlers via `notifyReceiptsChanged()`.
 */
export function ReceiptCoverageTile({ currency = 'CAD' }: Props) {
  const [filter, setFilter] = useState<ReceiptCompletenessFilter>('all')
  const completeness = useReceiptCompleteness(filter, currency ?? null)
  const missing = useMissingReceipts(filter, currency ?? null, 3)

  const coverageByCount = completeness.data?.coverageByCount ?? 0
  const coverageByAmount = completeness.data?.coverageByAmount ?? 0
  const missingCount = completeness.data?.missingCount ?? 0
  const missingAmount = completeness.data?.missingAmount ?? 0
  const headlineCurrency = completeness.data?.currency ?? currency ?? null

  const summary = useMemo(() => {
    if (missingCount === 0) {
      return 'Every spend transaction in this view has a receipt attached.'
    }
    const moneyLabel = headlineCurrency
      ? formatMoney(missingAmount, headlineCurrency)
      : missingAmount.toFixed(2)
    return `Missing ${missingCount} receipt${
      missingCount === 1 ? '' : 's'
    } worth ${moneyLabel}.`
  }, [missingCount, missingAmount, headlineCurrency])

  return (
    <BentoTile
      span={6}
      rows={2}
      aria-busy={completeness.loading}
      label="Receipt coverage"
      description="Spend transactions with a receipt attached. Updates when receipts are uploaded or deleted."
      actions={
        <div className="inline-flex rounded-md border border-border bg-muted p-0.5 text-xs">
          {FILTER_OPTIONS.map((opt) => {
            const active = filter === opt.value
            return (
              <Button
                key={opt.value}
                type="button"
                variant={active ? 'secondary' : 'ghost'}
                size="sm"
                onClick={() => setFilter(opt.value)}
                className="px-2 py-1"
                aria-pressed={active}
              >
                {opt.label}
              </Button>
            )
          })}
        </div>
      }
    >
      {completeness.loading && !completeness.data ? (
        <p className="text-sm text-muted-foreground">Loading receipt coverage…</p>
      ) : completeness.error ? (
        <p className="text-sm text-muted-foreground">
          {completeness.error.message || 'Receipt coverage unavailable.'}
        </p>
      ) : (
        <div className="space-y-3">
          <div className="flex flex-wrap items-baseline gap-x-6 gap-y-2">
            <div>
              <div className="text-3xl font-semibold tabular-nums">
                {formatPercent(coverageByCount)}
              </div>
              <div className="text-xs text-muted-foreground">By count</div>
            </div>
            <div>
              <div className="text-2xl font-semibold tabular-nums">
                {formatPercent(coverageByAmount)}
              </div>
              <div className="text-xs text-muted-foreground">By dollar amount</div>
            </div>
          </div>
          <p className="text-sm text-foreground">{summary}</p>
          {missing.data && missing.data.items.length > 0 ? (
            <div className="rounded-md border border-border bg-muted/40 p-2">
              <p className="mb-1 text-xs font-semibold text-muted-foreground">
                Largest missing
              </p>
              <ul className="space-y-1 text-sm">
                {missing.data.items.map((row) => (
                  <li key={row.id} className="flex items-baseline justify-between gap-2">
                    <Link
                      to={`/transactions?ids=${row.id}`}
                      className="truncate font-medium hover:underline"
                      title={row.merchant}
                    >
                      {row.merchant}
                    </Link>
                    <span className="shrink-0 tabular-nums text-muted-foreground">
                      {formatMoney(Math.abs(row.amount), row.currency)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          <div className="flex flex-wrap gap-3 text-xs">
            <Link
              to="/transactions"
              className="font-semibold text-foreground underline"
            >
              Open transactions to attach a receipt
            </Link>
          </div>
        </div>
      )}
    </BentoTile>
  )
}
