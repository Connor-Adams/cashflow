import { useTaxReturn } from '../../hooks/useTaxReturn';
import { MultiYearCompareCard } from './MultiYearCompareCard';
import { InstalmentTracker } from './InstalmentTracker';

export function OverviewTab({ year }: { year: number }) {
  const { data, error, loading } = useTaxReturn(year);
  if (loading) return <p className="muted">Computing…</p>;
  if (error) return <p className="error">Error: {error}</p>;
  if (!data) return null;
  return (
    <div>
      <h2>Year {year} — Estimated total payable</h2>
      <p className="big-number">${data.totals.totalPayable}</p>
      <ul>
        <li>Federal tax: ${data.totals.federalTax}</li>
        <li>Ontario tax (incl. surtax + OHP): ${data.totals.provincialTax}</li>
        <li>CPP: ${data.totals.cppContrib}</li>
        <li>EI: ${data.totals.eiPremium}</li>
      </ul>
      {data.warnings.length > 0 && (
        <section>
          <h3>Warnings</h3>
          <ul>{data.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
        </section>
      )}
      <p className="muted">{data.cached ? 'Cached snapshot' : 'Freshly computed'} at {new Date(data.computedAt).toLocaleString()}</p>
      <section>
        <MultiYearCompareCard from={year - 2} to={year} />
      </section>
      <section>
        <InstalmentTracker year={year} />
      </section>
    </div>
  );
}
