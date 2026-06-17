/**
 * Currency intelligence page (issue #221).
 *
 * Surfaces three panels:
 *   1. Exposure: per-currency split of the household's transaction activity,
 *      normalized to a user-selectable reporting currency.
 *   2. FX fees: transactions flagged by the heuristic as likely
 *      foreign-exchange / conversion fees.
 *   3. Effective rates: transactions where the bank's effective rate can be
 *      derived from a paired counterparty txn.
 *
 * Filter bar at the top drives all three panels.
 */
import { useState } from 'react'
import {
  useCurrencyExposure,
  useEffectiveRates,
  useFxFees,
  useFxReporting,
} from '@/hooks/useFxIntelligence'
import { formatMoney } from '@/lib/formatMoney'
import { toDateInputValue } from '@/lib/dateInput'

const REPORTING_CURRENCIES = ['CAD', 'USD', 'EUR', 'GBP'] as const

function defaultDateRange(): { from: string; to: string } {
  const to = new Date()
  const from = new Date(to)
  from.setFullYear(from.getFullYear() - 1)
  return { from: toDateInputValue(from), to: toDateInputValue(to) }
}

function formatPct(share: number): string {
  return `${(share * 100).toFixed(1)}%`
}

function formatRate(rate: number | null): string {
  if (rate == null) return '—'
  return rate.toFixed(4)
}

export function CurrencyPage() {
  const initial = defaultDateRange()
  const [dateFrom, setDateFrom] = useState(initial.from)
  const [dateTo, setDateTo] = useState(initial.to)
  const [reportingCurrency, setReportingCurrency] = useState<string>('CAD')

  const params = { dateFrom, dateTo, reportingCurrency }
  const exposure = useCurrencyExposure(params)
  const reporting = useFxReporting(params)
  const fees = useFxFees({ dateFrom, dateTo, limit: 100 })
  const rates = useEffectiveRates({ dateFrom, dateTo, limit: 100 })

  return (
    <div className="p-6 space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Currency intelligence</h1>
          <p className="text-sm text-muted-foreground">
            FX exposure, fee detection, and effective rates across your accounts.
          </p>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col text-xs">
            From
            <input
              type="date"
              value={dateFrom}
              onChange={(e) => setDateFrom(e.target.value)}
              className="rounded border px-2 py-1 text-sm"
            />
          </label>
          <label className="flex flex-col text-xs">
            To
            <input
              type="date"
              value={dateTo}
              onChange={(e) => setDateTo(e.target.value)}
              className="rounded border px-2 py-1 text-sm"
            />
          </label>
          <label className="flex flex-col text-xs">
            Reporting
            <select
              value={reportingCurrency}
              onChange={(e) => setReportingCurrency(e.target.value)}
              className="rounded border px-2 py-1 text-sm"
            >
              {REPORTING_CURRENCIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </label>
        </div>
      </header>

      <ExposurePanel exposure={exposure} reporting={reporting} />
      <FeesPanel fees={fees} />
      <EffectiveRatesPanel rates={rates} />
    </div>
  )
}

type ExposureResult = ReturnType<typeof useCurrencyExposure>
type ReportingResult = ReturnType<typeof useFxReporting>

function ExposurePanel({
  exposure,
  reporting,
}: {
  exposure: ExposureResult
  reporting: ReportingResult
}) {
  if (exposure.loading && !exposure.data) {
    return <section className="rounded border p-4">Loading exposure…</section>
  }
  const data = exposure.data
  if (!data) {
    return (
      <section className="rounded border p-4">
        <p>No exposure data{exposure.error ? `: ${exposure.error.message}` : ''}.</p>
      </section>
    )
  }

  const gapCurrencies = Array.from(new Set(data.gaps.map((g) => g.currency)))
  const reportingMetrics = reporting.data?.metrics ?? []
  const totalSpend = reportingMetrics.find((m) => m.key === 'totalSpend')
  const totalCredits = reportingMetrics.find((m) => m.key === 'totalCredits')
  const netSpend = reportingMetrics.find((m) => m.key === 'netSpend')

  return (
    <section className="rounded border p-4 space-y-3">
      <div className="flex items-baseline justify-between">
        <h2 className="text-lg font-medium">Exposure summary</h2>
        <span className="text-xs text-muted-foreground">As of {data.asOf}</span>
      </div>

      <dl className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
        <div>
          <dt className="text-muted-foreground">Total ({data.reportingCurrency})</dt>
          <dd className="text-xl font-semibold">
            {formatMoney(data.totalCadEquivalent, data.reportingCurrency)}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Total spend</dt>
          <dd className="text-xl font-semibold">
            {totalSpend
              ? formatMoney(totalSpend.normalized, data.reportingCurrency)
              : '—'}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Total credits</dt>
          <dd className="text-xl font-semibold">
            {totalCredits
              ? formatMoney(totalCredits.normalized, data.reportingCurrency)
              : '—'}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Net spend</dt>
          <dd className="text-xl font-semibold">
            {netSpend
              ? formatMoney(netSpend.normalized, data.reportingCurrency)
              : '—'}
          </dd>
        </div>
      </dl>

      {gapCurrencies.length > 0 && (
        <div
          role="alert"
          className="rounded border border-amber-400 bg-warning-bg text-warning p-3 text-sm"
        >
          FX rate unavailable for: {gapCurrencies.join(', ')} — these
          currencies are shown in native units only.
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-muted-foreground">
              <th className="py-1 pr-3">Currency</th>
              <th className="py-1 pr-3">Txns</th>
              <th className="py-1 pr-3">Net native</th>
              <th className="py-1 pr-3">FX rate</th>
              <th className="py-1 pr-3">In {data.reportingCurrency}</th>
              <th className="py-1 pr-3">Share</th>
            </tr>
          </thead>
          <tbody>
            {data.byCurrency.map((row) => (
              <tr key={row.currency} className="border-t">
                <td className="py-1 pr-3 font-medium">{row.currency}</td>
                <td className="py-1 pr-3">{row.transactionCount}</td>
                <td className="py-1 pr-3 tabular-nums">
                  {formatMoney(row.sumNative, row.currency)}
                </td>
                <td className="py-1 pr-3 tabular-nums">{formatRate(row.fxRate)}</td>
                <td className="py-1 pr-3 tabular-nums">
                  {row.cadEquivalent == null
                    ? '—'
                    : formatMoney(row.cadEquivalent, data.reportingCurrency)}
                </td>
                <td className="py-1 pr-3 tabular-nums">
                  {formatPct(row.shareOfTotal)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

type FeesResult = ReturnType<typeof useFxFees>

function FeesPanel({ fees }: { fees: FeesResult }) {
  if (fees.loading && !fees.data) {
    return <section className="rounded border p-4">Loading FX fees…</section>
  }
  const data = fees.data
  if (!data) {
    return (
      <section className="rounded border p-4">
        <p>No fees data{fees.error ? `: ${fees.error.message}` : ''}.</p>
      </section>
    )
  }
  return (
    <section className="rounded border p-4 space-y-3">
      <div className="flex items-baseline justify-between">
        <h2 className="text-lg font-medium">Likely FX fees</h2>
        <span className="text-xs text-muted-foreground">
          {data.total} flagged (limit {data.limit})
        </span>
      </div>
      {data.fees.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No FX or currency-conversion fees detected in this range.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-muted-foreground">
                <th className="py-1 pr-3">Date</th>
                <th className="py-1 pr-3">Account</th>
                <th className="py-1 pr-3">Merchant</th>
                <th className="py-1 pr-3">Amount</th>
                <th className="py-1 pr-3">Reason</th>
                <th className="py-1 pr-3">Confidence</th>
              </tr>
            </thead>
            <tbody>
              {data.fees.map((row) => (
                <tr key={row.transactionId} className="border-t">
                  <td className="py-1 pr-3 tabular-nums">{row.date}</td>
                  <td className="py-1 pr-3">{row.accountName ?? `#${row.accountId}`}</td>
                  <td className="py-1 pr-3">{row.merchant}</td>
                  <td className="py-1 pr-3 tabular-nums">
                    {formatMoney(row.amount, row.currency)}
                  </td>
                  <td className="py-1 pr-3 text-xs text-muted-foreground">
                    {row.reason}
                  </td>
                  <td className="py-1 pr-3">
                    <span
                      className={
                        row.confidence === 'high'
                          ? 'rounded bg-success-bg px-2 py-0.5 text-xs text-success-foreground'
                          : 'rounded bg-warning-bg px-2 py-0.5 text-xs text-warning'
                      }
                    >
                      {row.confidence ?? 'low'}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

type RatesResult = ReturnType<typeof useEffectiveRates>

function EffectiveRatesPanel({ rates }: { rates: RatesResult }) {
  if (rates.loading && !rates.data) {
    return <section className="rounded border p-4">Loading effective rates…</section>
  }
  const data = rates.data
  if (!data) {
    return (
      <section className="rounded border p-4">
        <p>No effective-rate data{rates.error ? `: ${rates.error.message}` : ''}.</p>
      </section>
    )
  }
  return (
    <section className="rounded border p-4 space-y-3">
      <div className="flex items-baseline justify-between">
        <h2 className="text-lg font-medium">Effective FX rates</h2>
        <span className="text-xs text-muted-foreground">
          {data.total} derivable (limit {data.limit})
        </span>
      </div>
      {data.rates.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No transactions with derivable effective rates in this range. This
          happens when there are no same-date cross-currency pairs on any
          account.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-muted-foreground">
                <th className="py-1 pr-3">Date</th>
                <th className="py-1 pr-3">Merchant</th>
                <th className="py-1 pr-3">Native amount</th>
                <th className="py-1 pr-3">Effective rate</th>
                <th className="py-1 pr-3">Source</th>
              </tr>
            </thead>
            <tbody>
              {data.rates.map((row) => (
                <tr key={row.transactionId} className="border-t">
                  <td className="py-1 pr-3 tabular-nums">{row.date}</td>
                  <td className="py-1 pr-3">{row.merchant || `#${row.transactionId}`}</td>
                  <td className="py-1 pr-3 tabular-nums">
                    {formatMoney(row.nativeAmount, row.fromCurrency)}
                  </td>
                  <td className="py-1 pr-3 tabular-nums">
                    {formatRate(row.effectiveRate)} {row.fromCurrency}→{row.toCurrency}
                  </td>
                  <td className="py-1 pr-3 text-xs text-muted-foreground">
                    {row.source.replace('_', ' ')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
