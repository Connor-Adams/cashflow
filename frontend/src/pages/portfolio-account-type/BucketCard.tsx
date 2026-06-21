import { AllocationDonut } from '@/components/ui/allocation-donut'
import { Card } from '@connor-adams/designsystem'
import { formatMoney } from '../../lib/formatMoney'
import type { PortfolioByAccountTypeBucket } from '../../types/api'

export type BucketCardProps = {
  bucket: PortfolioByAccountTypeBucket
}

export function BucketCard({ bucket }: BucketCardProps) {
  const totalLabel =
    bucket.totalCadMV != null ? formatMoney(bucket.totalCadMV, 'CAD') : '—'
  const acctCount = bucket.accounts.length
  return (
    <Card>
      <div className="transactionsPanelHeader">
        <div>
          <h2 className="text-base">{bucket.label}</h2>
          <p className="muted">
            <span>{totalLabel}</span> · {bucket.holdingsCount} holdings · {acctCount}{' '}
            {acctCount === 1 ? 'account' : 'accounts'}
          </p>
        </div>
      </div>
      <AllocationDonut
        title={`Allocation by asset type`}
        wrapInCard={false}
        slices={bucket.allocationByAssetType.map((row, i) => ({
          key: `${row.assetType ?? 'other'}-${i}`,
          name: row.assetType ?? 'Other',
          value: row.marketValueCad,
          currency: 'CAD',
          percentage: row.percentage,
        }))}
      />
    </Card>
  )
}
