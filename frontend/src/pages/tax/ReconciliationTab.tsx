import { useReconciliation, type ReconciliationFinding } from '../../hooks/useReconciliation';
import { useTaxReturn } from '../../hooks/useTaxReturn';

export function ReconciliationTab({ year }: { year: number }) {
  const taxReturn = useTaxReturn(year);
  const recon = useReconciliation(year);

  if (taxReturn.loading || recon.loading) return <p className="muted">Loading…</p>;

  const engineWarnings = taxReturn.data?.warnings ?? [];
  const report = recon.data;
  const reconError = recon.error;
  const returnError = taxReturn.error;

  const totalReconFindings = report?.findings.length ?? 0;

  return (
    <div>
      <h2>Reconciliation — {year}</h2>

      <div className="card" style={{ marginBottom: '1rem' }}>
        <p>
          <strong>{engineWarnings.length}</strong>{' '}
          engine {engineWarnings.length === 1 ? 'warning' : 'warnings'} ·{' '}
          <strong>{totalReconFindings}</strong> reconciliation{' '}
          {totalReconFindings === 1 ? 'finding' : 'findings'}
        </p>
      </div>

      {returnError && <p className="error">Engine warnings unavailable: {returnError}</p>}
      {reconError && <p className="error">Reconciliation report unavailable: {reconError}</p>}

      <section style={{ marginBottom: '1.5rem' }}>
        <h3>Engine warnings</h3>
        {engineWarnings.length === 0 ? (
          <p className="muted">No engine warnings for {year}.</p>
        ) : (
          <ul>
            {engineWarnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        )}
      </section>

      {report && (
        <>
          <DetectorSection
            title="Missing slips"
            count={report.counts.missing_slip}
            findings={report.findings.filter((f) => f.category === 'missing_slip')}
          />
          <DetectorSection
            title="Slip vs. transaction divergence"
            count={report.counts.slip_divergence}
            findings={report.findings.filter((f) => f.category === 'slip_divergence')}
          />
          <DetectorSection
            title="Category review"
            count={report.counts.category_misclass}
            findings={report.findings.filter((f) => f.category === 'category_misclass')}
          />
        </>
      )}
    </div>
  );
}

function DetectorSection({
  title,
  count,
  findings,
}: {
  title: string;
  count: number;
  findings: ReconciliationFinding[];
}) {
  return (
    <section style={{ marginBottom: '1.5rem' }}>
      <h3>
        {title} <span className="muted">({count})</span>
      </h3>
      {findings.length === 0 ? (
        <p className="muted">None.</p>
      ) : (
        <ul>
          {findings.map((f, i) => (
            <li key={i}>
              <strong>{f.subjectRef}</strong> — {f.message}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
