import { TableCard } from '@/components/ui/table-card'
import { EmptyTableRow } from '@/lib/ds-extras'
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from '@connor-adams/designsystem'
import { formatMoney } from '../../lib/formatMoney'
import type { PortfolioByAccountTypeBucket } from '../../types/api'

export type BucketBreakdownTableProps = {
  buckets: PortfolioByAccountTypeBucket[]
}

export function BucketBreakdownTable({ buckets }: BucketBreakdownTableProps) {
  const allRows = buckets.flatMap((b) =>
    b.rows.map((r) => ({ ...r, bucketLabel: b.label })),
  )
  return (
    <TableCard
      title="Breakdown"
      description="All holdings grouped by bucket label."
      className="mt-4 mb-0"
    >
      <TableHeader>
        <TableRow>
          <TableHead>Bucket</TableHead>
          <TableHead>Account</TableHead>
          <TableHead>Symbol</TableHead>
          <TableHead>Qty</TableHead>
          <TableHead>MV (CAD)</TableHead>
          <TableHead>Weight</TableHead>
          <TableHead>Flags</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {allRows.map((r) => (
          <TableRow key={`${r.bucketLabel}-${r.accountId}-${r.securityId}`}>
            <TableCell>{r.bucketLabel}</TableCell>
            <TableCell>{r.accountName}</TableCell>
            <TableCell>{r.symbol}</TableCell>
            <TableCell>{r.quantity}</TableCell>
            <TableCell>
              {r.marketValueCad != null ? formatMoney(r.marketValueCad, 'CAD') : '—'}
            </TableCell>
            <TableCell>
              {r.weightInBucketPct != null
                ? `${r.weightInBucketPct.toFixed(1)}%`
                : '—'}
            </TableCell>
            <TableCell style={{ fontSize: '0.75em' }}>
              {r.flags.length > 0 ? r.flags.join(', ') : '—'}
            </TableCell>
          </TableRow>
        ))}
        {allRows.length === 0 && (
          <EmptyTableRow
            colSpan={7}
            title="No holdings."
            description="Import an investment statement to populate this view."
          />
        )}
      </TableBody>
    </TableCard>
  )
}
