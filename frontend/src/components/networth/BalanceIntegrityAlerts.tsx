import { useId } from 'react'
import type { BalanceIntegrity } from '@cashflow/shared'
import {
  Table, TableHeader, TableBody, TableHead, TableRow, TableCell } from '@connor-adams/designsystem'
import { formatMoney } from '@/lib/formatMoney'

/**
 * Balance-reconciliation warnings for the net-worth page: statements whose
 * closing balance disagrees with the computed balance at period end, and
 * accounts whose opening balance has no date (which balanceAtDate treats as
 * standing before all history). Styled like the page's other role="alert"
 * banners; renders nothing when there is nothing to report.
 */
export function BalanceIntegrityAlerts({ integrity }: { integrity: BalanceIntegrity | null }) {
  const mismatchTitleId = useId()
  const undatedTitleId = useId()
  if (!integrity) return null
  const { statementMismatches, undatedOpeningBalances } = integrity
  const mismatchCount = statementMismatches.length
  const undatedCount = undatedOpeningBalances.length

  return (
    <>
      {mismatchCount > 0 && (
        <div
          role="alert"
          aria-labelledby={mismatchTitleId}
          className="rounded border border-warning bg-warning-bg text-warning p-3 text-sm space-y-2"
        >
          <div id={mismatchTitleId}>
            <span className="sr-only">Statement balances: </span>
            <strong>{mismatchCount}</strong> statement balance
            {mismatchCount === 1 ? ' disagrees' : 's disagree'} with the bank — the
            computed balance at the statement date is not what the statement printed.
            Amounts owed are shown as positive.
          </div>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Account</TableHead>
                  <TableHead>Statement date</TableHead>
                  <TableHead className="text-right">Computed</TableHead>
                  <TableHead className="text-right">Statement</TableHead>
                  <TableHead className="text-right">Difference</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {statementMismatches.map((m) => (
                  <TableRow key={m.statementId}>
                    <TableCell>{m.accountName}</TableCell>
                    <TableCell>{m.statementDate}</TableCell>
                    <TableCell className="text-right">
                      {formatMoney(m.computedBalance, m.currency)}
                    </TableCell>
                    <TableCell className="text-right">
                      {formatMoney(m.statementBalance, m.currency)}
                    </TableCell>
                    <TableCell className="text-right">
                      {formatMoney(m.delta, m.currency)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>
      )}

      {undatedCount > 0 && (
        <div
          role="alert"
          aria-labelledby={undatedTitleId}
          className="rounded border border-warning bg-warning-bg text-warning p-3 text-sm space-y-1"
        >
          <div id={undatedTitleId}>
            <span className="sr-only">Opening balances: </span>
            <strong>{undatedCount}</strong> account
            {undatedCount === 1 ? ' has' : 's have'} an opening balance with no opening-balance
            date. It is counted before all imported history, so if that history already covers
            it, the balance is double-counted.
          </div>
          <ul className="list-disc pl-5">
            {undatedOpeningBalances.map((u) => (
              <li key={u.accountId}>
                {u.accountName}: {formatMoney(u.openingBalance, u.currency)}
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  )
}
