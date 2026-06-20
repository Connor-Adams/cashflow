import { useMemo, useState } from 'react'
import { Card } from '@connor-adams/designsystem'
import type { PortfolioPerformanceByAccount } from '../../types/api'
import { formatMoney } from '../../lib/formatMoney'

type SortKey = 'accountName' | 'twrPct' | 'endValueCad' | 'weightInPortfolioPct'

export type ByAccountTableProps = {
  rows: PortfolioPerformanceByAccount[]
}

function fmtPct(x: number): string {
  return `${x.toFixed(2)}%`
}

export function ByAccountTable({ rows }: ByAccountTableProps) {
  const [sortKey, setSortKey] = useState<SortKey>('endValueCad')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')

  const sorted = useMemo(() => {
    return [...rows].sort((a, b) => {
      const av = a[sortKey]; const bv = b[sortKey]
      let cmp = 0
      if (typeof av === 'number' && typeof bv === 'number') cmp = av - bv
      else cmp = String(av).localeCompare(String(bv))
      return sortDir === 'asc' ? cmp : -cmp
    })
  }, [rows, sortKey, sortDir])

  function toggleSort(k: SortKey) {
    if (sortKey === k) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    else { setSortKey(k); setSortDir('desc') }
  }

  if (rows.length === 0) {
    return <Card><p className="text-sm text-muted-foreground">No per-account data for selected range.</p></Card>
  }

  return (
    <Card>
      <h4 className="font-medium mb-2">By account</h4>
      <table className="w-full text-sm">
        <thead>
          <tr>
            <th onClick={() => toggleSort('accountName')} className="cursor-pointer text-left">Account</th>
            <th onClick={() => toggleSort('endValueCad')} className="cursor-pointer text-right">End value (CAD)</th>
            <th onClick={() => toggleSort('weightInPortfolioPct')} className="cursor-pointer text-right">Weight</th>
            <th onClick={() => toggleSort('twrPct')} className="cursor-pointer text-right">TWR</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((r) => (
            <tr key={r.accountId} data-testid="byacct-row">
              <td>{r.accountName}</td>
              <td className="text-right">{formatMoney(r.endValueCad, 'CAD')}</td>
              <td className="text-right">{fmtPct(r.weightInPortfolioPct)}</td>
              <td className={`text-right ${r.twrPct >= 0 ? 'text-positive' : 'text-negative'}`}>{fmtPct(r.twrPct)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  )
}
