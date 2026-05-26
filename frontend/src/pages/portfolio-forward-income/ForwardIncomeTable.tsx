import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import type { PortfolioForwardIncomeRow } from '../../types/api'
import { formatMoney } from '../../lib/formatMoney'

type SortKey =
  | 'symbol' | 'projectedAnnualIncomeNative' | 'projectedAnnualIncomeCad'
  | 'forwardYieldPct' | 'forwardYieldOnCostPct' | 'cadenceLabel'

export type ForwardIncomeTableProps = {
  rows: PortfolioForwardIncomeRow[]
}

function fmtPct(x: number): string {
  return `${x.toFixed(2)}%`
}

export function ForwardIncomeTable({ rows }: ForwardIncomeTableProps) {
  const [sortKey, setSortKey] = useState<SortKey>('projectedAnnualIncomeCad')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')
  const [hideUnreliable, setHideUnreliable] = useState(false)

  const display = useMemo(() => {
    const filtered = hideUnreliable ? rows.filter((r) => !r.unreliable) : rows
    const sorted = [...filtered].sort((a, b) => {
      const av = a[sortKey]
      const bv = b[sortKey]
      let cmp = 0
      if (typeof av === 'number' && typeof bv === 'number') cmp = av - bv
      else cmp = String(av).localeCompare(String(bv))
      return sortDir === 'asc' ? cmp : -cmp
    })
    return sorted
  }, [rows, sortKey, sortDir, hideUnreliable])

  function toggleSort(k: SortKey) {
    if (sortKey === k) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    else { setSortKey(k); setSortDir('desc') }
  }

  return (
    <div className="mt-3">
      <label className="flex items-center gap-2 mb-2 text-sm">
        <input
          type="checkbox"
          checked={hideUnreliable}
          onChange={(e) => setHideUnreliable(e.target.checked)}
        />
        <span>Hide unreliable</span>
      </label>
      <table className="w-full text-sm">
        <thead>
          <tr>
            <th onClick={() => toggleSort('symbol')} className="cursor-pointer text-left">Symbol</th>
            <th className="text-right">Qty</th>
            <th onClick={() => toggleSort('projectedAnnualIncomeNative')} className="cursor-pointer text-right">Annual (native)</th>
            <th onClick={() => toggleSort('projectedAnnualIncomeCad')} className="cursor-pointer text-right">Annual (CAD)</th>
            <th onClick={() => toggleSort('forwardYieldPct')} className="cursor-pointer text-right">Yield</th>
            <th onClick={() => toggleSort('forwardYieldOnCostPct')} className="cursor-pointer text-right">YoC</th>
            <th onClick={() => toggleSort('cadenceLabel')} className="cursor-pointer text-left">Cadence</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {display.map((r) => (
            <tr key={r.securityId}>
              <td>
                <Link to={`/portfolio/security/${r.securityId}`} data-testid="fi-row-symbol">
                  {r.symbol}
                </Link>
              </td>
              <td className="text-right">{r.qty.toLocaleString()}</td>
              <td className="text-right">{formatMoney(r.projectedAnnualIncomeNative, r.currency)}</td>
              <td className="text-right">{formatMoney(r.projectedAnnualIncomeCad, 'CAD')}</td>
              <td className="text-right">{fmtPct(r.forwardYieldPct)}</td>
              <td className="text-right">{fmtPct(r.forwardYieldOnCostPct)}</td>
              <td>{r.cadenceLabel}</td>
              <td>{r.unreliable && <span title="Unreliable cadence" aria-label="Unreliable">⚠</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
