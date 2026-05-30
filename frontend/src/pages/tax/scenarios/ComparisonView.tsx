import { useScenarioComparison } from '../../../hooks/useScenarioComparison';

interface Props {
  ids: number[];
  onClose: () => void;
  /**
   * Optional override for the compare endpoint. Defaults to the personal
   * scenarios endpoint. Corp scenarios pass `/api/tax/scenarios/corp/compare`.
   * The hook returns the same `ScenarioWithComputed[]` shape either way.
   */
  endpoint?: string;
}

// NOTE: TOTAL_KEYS is hard-coded to personal-tax line codes (totalIncome,
// federalTax, …). For corp scenarios those keys aren't present in the totals
// payload, so the rows render blank under each corp column. Acceptable for
// P8a v1 — P8b can add a corp-aware variant or make this prop-driven.
const TOTAL_KEYS = [
  'totalIncome', 'netIncome', 'taxableIncome',
  'federalTax', 'provincialTax', 'cppContrib', 'eiPremium',
  'totalPayable', 'refundOrOwing',
];

export function ComparisonView({ ids, onClose, endpoint }: Props) {
  const { data, loading, error } = useScenarioComparison(ids, endpoint);
  if (loading) return <p className="muted">Comparing…</p>;
  if (error) return <p className="error">Compare failed: {error}</p>;
  if (data.length === 0) return null;

  return (
    <div className="card" style={{ marginTop: '1rem' }}>
      <header style={{ display: 'flex', justifyContent: 'space-between' }}>
        <h3>Comparing {data.length} scenario{data.length === 1 ? '' : 's'}</h3>
        <button onClick={onClose}>Close</button>
      </header>
      <table>
        <thead>
          <tr>
            <th>Line</th>
            {data.map((row) => <th key={row.scenario.id}>{row.scenario.name}</th>)}
          </tr>
        </thead>
        <tbody>
          {TOTAL_KEYS.map((k) => (
            <tr key={k}>
              <td><strong>{k}</strong></td>
              {data.map((row) => (
                <td key={row.scenario.id}>
                  {formatCell(row.computed.totals[k])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function formatCell(value: unknown): string {
  if (value == null) return '—';
  const n = typeof value === 'string' ? Number(value) : (value as number);
  if (!Number.isFinite(n)) return String(value);
  return n.toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
