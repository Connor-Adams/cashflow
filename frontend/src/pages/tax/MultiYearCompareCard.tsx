import { useTaxYearCompare } from '../../hooks/useTaxYears';
import { fmtCurrency, refundOrOwing } from './util/format';
import {
  Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@connor-adams/designsystem'

type Props = {
  from: number;
  to: number;
};

export function MultiYearCompareCard({ from, to }: Props) {
  const { years, loading, error } = useTaxYearCompare(from, to);

  if (loading) return <p className="muted">Loading multi-year comparison…</p>;
  if (error) return <p className="error">Error loading comparison: {error}</p>;
  if (years.length === 0) return <p className="muted">No tax year data available for {from}–{to}.</p>;

  return (
    <div>
      <h3>Year-over-year comparison ({from}–{to})</h3>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Year</TableHead>
            <TableHead className="text-right">Total Income</TableHead>
            <TableHead className="text-right">Federal Tax</TableHead>
            <TableHead className="text-right">ON Tax</TableHead>
            <TableHead className="text-right">Total Payable</TableHead>
            <TableHead className="text-right">Refund / Owing</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {years.map((y) => {
            const balance = refundOrOwing(y.totals.refundOrOwing);
            return (
              <TableRow key={y.year}>
                <TableCell>{y.year}</TableCell>
                <TableCell className="text-right tabular-nums">{fmtCurrency(y.totals.totalIncome)}</TableCell>
                <TableCell className="text-right tabular-nums">{fmtCurrency(y.totals.federalTax)}</TableCell>
                <TableCell className="text-right tabular-nums">{fmtCurrency(y.totals.provincialTax)}</TableCell>
                <TableCell className="text-right tabular-nums">{fmtCurrency(y.totals.totalPayable)}</TableCell>
                <TableCell className="text-right tabular-nums">
                  {balance ? `${balance.label} ${balance.amount}` : '—'}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
