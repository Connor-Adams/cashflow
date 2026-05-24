import { useTaxReturn } from '../../hooks/useTaxReturn';

export function ReconciliationTab({ year }: { year: number }) {
  const { data, error, loading } = useTaxReturn(year);

  if (loading) return <p className="muted">Loading…</p>;
  if (error) return <p className="error">Error: {error}</p>;
  if (!data) return null;

  const warnings = data.warnings;

  return (
    <div>
      <h2>Reconciliation — {year}</h2>
      <div className="card" style={{ marginBottom: '1rem' }}>
        <p>
          <strong>{warnings.length}</strong>{' '}
          {warnings.length === 1 ? 'divergence' : 'divergences'} flagged for {year}.
        </p>
      </div>
      {warnings.length === 0 ? (
        <p className="muted">No divergences detected for {year}.</p>
      ) : (
        <ul>
          {warnings.map((w, i) => (
            <li key={i}>{w}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
