import { useReconciliation, type ReconciliationFinding } from '../../hooks/useReconciliation';
import { useTaxReturn } from '../../hooks/useTaxReturn';
import { StatCard } from '@/components/ui/stat-card';
import { Card } from '@cashflow/ui';

export function ReconciliationTab({ year }: { year: number }) {
  const taxReturn = useTaxReturn(year);
  const recon = useReconciliation(year);

  if (taxReturn.loading || recon.loading) return <p className="muted">Loading…</p>;

  const engineWarnings = taxReturn.data?.warnings ?? [];
  const report = recon.data;
  const reconError = recon.error;
  const returnError = taxReturn.error;

  const totalReconFindings = report?.findings.length ?? 0;
  const categoryCount = report
    ? Object.values(report.counts).filter((c) => c > 0).length
    : 0;

  return (
    <div>
      <h2>Reconciliation — {year}</h2>

      <div className="mb-4 grid grid-cols-2 gap-3 max-w-md">
        <StatCard
          label="Engine warnings"
          value={String(engineWarnings.length)}
          hint={engineWarnings.length === 0 ? 'No issues' : undefined}
        />
        <StatCard
          label="Reconciliation findings"
          value={String(totalReconFindings)}
          hint={categoryCount > 0 ? `across ${categoryCount} ${categoryCount === 1 ? 'category' : 'categories'}` : undefined}
        />
      </div>

      {returnError && <p className="error">Engine warnings unavailable: {returnError}</p>}
      {reconError && <p className="error">Reconciliation report unavailable: {reconError}</p>}

      <Card className="mb-6">
        <h3 className="mb-3 text-base font-semibold">Engine warnings</h3>
        {engineWarnings.length === 0 ? (
          <p className="muted">No engine warnings for {year}.</p>
        ) : (
          <ul>
            {engineWarnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        )}
      </Card>

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
    <Card className="mb-4">
      <h3 className="mb-3 text-base font-semibold">
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
    </Card>
  );
}
