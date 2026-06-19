import { Card } from '@cashflow/ui'
import type { PortfolioForwardIncomeAssetBucket } from '../../types/api'
import { formatMoney } from '../../lib/formatMoney'

export type ByAssetTypeBreakdownProps = {
  buckets: PortfolioForwardIncomeAssetBucket[]
}

export function ByAssetTypeBreakdown({ buckets }: ByAssetTypeBreakdownProps) {
  if (buckets.length === 0) return <p className="text-sm text-muted-foreground">No projected income by asset type.</p>
  return (
    <Card>
      <h4 className="font-medium mb-2">By asset type</h4>
      <table className="w-full text-sm">
        <thead><tr><th className="text-left">Asset type</th><th className="text-left">Currencies</th><th className="text-right">Total (CAD)</th></tr></thead>
        <tbody>
          {buckets.map((b) => (
            <tr key={b.assetType}>
              <td>{b.assetType}</td>
              <td>{b.byCurrency.map((c) => `${c.currency} ${formatMoney(c.amount, c.currency)}`).join(' • ')}</td>
              <td className="text-right">{formatMoney(b.totalCad, 'CAD')}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  )
}
