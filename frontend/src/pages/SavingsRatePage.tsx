import { useCallback, useEffect, useMemo, useState } from 'react'
import { TrendingUp } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { NativeSelect } from '@/components/ui/native-select'
import { PageHeader } from '@/components/ui/page-header'
import { getJson } from '../lib/api'
import { formatMoney } from '../lib/formatMoney'
import type { SavingsRateResponse } from '../types/api'

const WINDOW_OPTIONS = [6, 12, 18, 24, 36]

function defaultMonth(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

function formatPct(pct: number | null): string {
  if (pct == null) return 'n/a'
  return `${Math.round(pct)}%`
}

export function SavingsRatePage() {
  const [month, setMonth] = useState<string>(defaultMonth())
  const [months, setMonths] = useState<number>(12)
  const [currency, setCurrency] = useState<string>('')
  const [includeInvestments, setIncludeInvestments] = useState<boolean>(true)
  const [includeDebtPrincipal, setIncludeDebtPrincipal] = useState<boolean>(true)
  const [data, setData] = useState<SavingsRateResponse | null>(null)
  const [loading, setLoading] = useState<boolean>(true)
  const [err, setErr] = useState<string | null>(null)

  const queryString = useMemo(() => {
    const params = new URLSearchParams()
    params.set('month', month)
    params.set('months', String(months))
    if (currency) params.set('currency', currency)
    params.set('includeInvestments', String(includeInvestments))
    params.set('includeDebtPrincipal', String(includeDebtPrincipal))
    return params.toString()
  }, [month, months, currency, includeInvestments, includeDebtPrincipal])

  const fetchData = useCallback(async () => {
    try {
      setLoading(true)
      setErr(null)
      const result = await getJson<SavingsRateResponse>(
        `/api/reports/savings-rate?${queryString}`
      )
      setData(result)
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed to fetch savings rate data')
    } finally {
      setLoading(false)
    }
  }, [queryString])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  const currencies = data ? Object.keys(data.currencyTrends) : []
  const displayCurrency = currency || currencies[0]
  const trend = displayCurrency ? data?.currencyTrends[displayCurrency] : null

  return (
    <div className="space-y-6">
      <PageHeader
        title="Savings Rate"
        subtitle="Track your monthly savings, investments, and debt paydown"
        icon={TrendingUp}
      />

      {/* Controls */}
      <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Anchor Month
            </label>
            <input
              type="month"
              value={month}
              onChange={(e) => setMonth(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-md"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Window (months)
            </label>
            <NativeSelect
              value={String(months)}
              onChange={(e) => setMonths(Number(e.target.value))}
            >
              {WINDOW_OPTIONS.map((opt) => (
                <option key={opt} value={String(opt)}>
                  {opt}
                </option>
              ))}
            </NativeSelect>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Currency
            </label>
            <NativeSelect
              value={currency}
              onChange={(e) => setCurrency(e.target.value)}
            >
              <option value="">All currencies</option>
              {currencies.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </NativeSelect>
          </div>
        </div>

        <div className="flex gap-4">
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={includeInvestments}
              onChange={(e) => setIncludeInvestments(e.target.checked)}
              className="rounded"
            />
            <span className="text-sm text-gray-700">Include investments</span>
          </label>
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={includeDebtPrincipal}
              onChange={(e) => setIncludeDebtPrincipal(e.target.checked)}
              className="rounded"
            />
            <span className="text-sm text-gray-700">Include debt principal</span>
          </label>
        </div>
      </div>

      {/* Loading / Error */}
      {loading && <div className="text-center py-8 text-gray-500">Loading...</div>}
      {err && <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded">{err}</div>}

      {/* Data Display */}
      {!loading && !err && trend && (
        <div className="space-y-6">
          {/* Summary Cards */}
          <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
            <div className="bg-white rounded-lg border border-gray-200 p-4">
              <div className="text-sm font-medium text-gray-600">Income</div>
              <div className="text-2xl font-bold text-gray-900">
                {formatMoney(trend.totals.income, displayCurrency)}
              </div>
            </div>
            <div className="bg-white rounded-lg border border-gray-200 p-4">
              <div className="text-sm font-medium text-gray-600">Spending</div>
              <div className="text-2xl font-bold text-gray-900">
                {formatMoney(trend.totals.spending, displayCurrency)}
              </div>
            </div>
            <div className="bg-white rounded-lg border border-gray-200 p-4">
              <div className="text-sm font-medium text-gray-600">Savings</div>
              <div className="text-2xl font-bold text-green-600">
                {formatMoney(trend.totals.savings, displayCurrency)}
              </div>
            </div>
            <div className="bg-white rounded-lg border border-gray-200 p-4">
              <div className="text-sm font-medium text-gray-600">Investments</div>
              <div className="text-2xl font-bold text-blue-600">
                {formatMoney(trend.totals.investments, displayCurrency)}
              </div>
            </div>
            <div className="bg-white rounded-lg border border-gray-200 p-4">
              <div className="text-sm font-medium text-gray-600">Avg Rate</div>
              <div className="text-2xl font-bold text-purple-600">
                {formatPct(trend.totals.avgSavingsRate)}
              </div>
            </div>
          </div>

          {/* Monthly Breakdown Table */}
          <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
            <table className="w-full">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr>
                  <th className="px-4 py-3 text-left text-sm font-semibold text-gray-900">Month</th>
                  <th className="px-4 py-3 text-right text-sm font-semibold text-gray-900">Income</th>
                  <th className="px-4 py-3 text-right text-sm font-semibold text-gray-900">Spending</th>
                  <th className="px-4 py-3 text-right text-sm font-semibold text-gray-900">Savings</th>
                  <th className="px-4 py-3 text-right text-sm font-semibold text-gray-900">Investments</th>
                  <th className="px-4 py-3 text-right text-sm font-semibold text-gray-900">Debt Principal</th>
                  <th className="px-4 py-3 text-right text-sm font-semibold text-gray-900">Rate</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200">
                {trend.series.map((point) => (
                  <tr key={point.month} className="hover:bg-gray-50">
                    <td className="px-4 py-3 font-medium text-gray-900">{point.month}</td>
                    <td className="px-4 py-3 text-right text-gray-900">
                      {formatMoney(point.income, displayCurrency)}
                    </td>
                    <td className="px-4 py-3 text-right text-gray-900">
                      {formatMoney(point.spending, displayCurrency)}
                    </td>
                    <td className="px-4 py-3 text-right text-green-600 font-medium">
                      {formatMoney(point.savings, displayCurrency)}
                    </td>
                    <td className="px-4 py-3 text-right text-blue-600 font-medium">
                      {formatMoney(point.investments, displayCurrency)}
                    </td>
                    <td className="px-4 py-3 text-right text-gray-900">
                      {formatMoney(point.debtPrincipal, displayCurrency)}
                    </td>
                    <td className="px-4 py-3 text-right font-semibold">
                      <Badge variant={point.savingsRate && point.savingsRate > 30 ? 'default' : 'secondary'}>
                        {formatPct(point.savingsRate)}
                      </Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Help text */}
      <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
        <h3 className="font-semibold text-blue-900 mb-2">How is this calculated?</h3>
        <ul className="text-sm text-blue-900 space-y-1">
          <li>• <strong>Income:</strong> positive amounts from income transactions</li>
          <li>• <strong>Spending:</strong> negative amounts on non-savings/investment/loan accounts</li>
          <li>• <strong>Savings:</strong> transfers into savings accounts or deposits</li>
          <li>• <strong>Investments:</strong> transfers to investment accounts or investment transactions</li>
          <li>• <strong>Debt Principal:</strong> payments to loans or credit cards</li>
          <li>• <strong>Rate:</strong> (Savings + [Investments] + [Debt Principal]) / Income</li>
        </ul>
      </div>
    </div>
  )
}
