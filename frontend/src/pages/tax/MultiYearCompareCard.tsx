import { useTaxYearCompare } from '../../hooks/useTaxYears';

function fmt(val: string | undefined): string {
  if (val == null) return '—';
  const n = parseFloat(val);
  if (isNaN(n)) return val;
  return n < 0
    ? `(${Math.abs(n).toFixed(2)})`
    : n.toFixed(2);
}

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
      <table>
        <thead>
          <tr>
            <th>Year</th>
            <th>Total Income</th>
            <th>Federal Tax</th>
            <th>ON Tax</th>
            <th>Total Payable</th>
            <th>Refund / Owing</th>
          </tr>
        </thead>
        <tbody>
          {years.map((y) => {
            const owing = parseFloat(y.totals.totalPayable ?? '0');
            const refund = -owing;
            return (
              <tr key={y.year}>
                <td>{y.year}</td>
                <td>${fmt(y.totals.totalIncome)}</td>
                <td>${fmt(y.totals.federalTax)}</td>
                <td>${fmt(y.totals.provincialTax)}</td>
                <td>${fmt(y.totals.totalPayable)}</td>
                <td>{owing >= 0 ? `Owing $${owing.toFixed(2)}` : `Refund $${Math.abs(refund).toFixed(2)}`}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
