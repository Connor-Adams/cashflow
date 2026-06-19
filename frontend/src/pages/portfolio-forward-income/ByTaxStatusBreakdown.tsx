import { Card } from '@cashflow/ui'
import type { PortfolioForwardIncomeTaxBucket } from '../../types/api'
import { formatMoney } from '../../lib/formatMoney'

const TAX_LABEL: Record<PortfolioForwardIncomeTaxBucket['taxStatus'], string> = {
  registered_tfsa: 'TFSA',
  registered_rrsp: 'RRSP',
  registered_fhsa: 'FHSA',
  registered_rrif: 'RRIF',
  registered_rdsp: 'RDSP',
  registered_resp: 'RESP',
  non_registered: 'Non-registered',
  n_a: 'Other',
}

export type ByTaxStatusBreakdownProps = {
  buckets: PortfolioForwardIncomeTaxBucket[]
}

export function ByTaxStatusBreakdown({ buckets }: ByTaxStatusBreakdownProps) {
  if (buckets.length === 0) return <p className="text-sm text-muted-foreground">No projected income by tax status.</p>
  return (
    <Card>
      <h4 className="font-medium mb-2">By account type</h4>
      <table className="w-full text-sm">
        <thead><tr><th className="text-left">Bucket</th><th className="text-left">Currencies</th><th className="text-right">Total (CAD)</th></tr></thead>
        <tbody>
          {buckets.map((b) => (
            <tr key={b.taxStatus}>
              <td>{TAX_LABEL[b.taxStatus]}</td>
              <td>{b.byCurrency.map((c) => `${c.currency} ${formatMoney(c.amount, c.currency)}`).join(' • ')}</td>
              <td className="text-right">{formatMoney(b.totalCad, 'CAD')}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  )
}
