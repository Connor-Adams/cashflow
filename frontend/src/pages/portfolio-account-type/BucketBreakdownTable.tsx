import { Card } from '@/components/ui/card'
import { EmptyTableRow } from '@/components/ui/empty-state'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
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
    <Card className="transactionsTableCard mt-4">
      <div className="transactionsPanelHeader">
        <div>
          <h2>Breakdown</h2>
          <p className="muted">All holdings grouped by bucket label.</p>
        </div>
      </div>
      <div className="transactionsTableWrap">
        <Table className="table transactionsTable">
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
        </Table>
      </div>
    </Card>
  )
}
