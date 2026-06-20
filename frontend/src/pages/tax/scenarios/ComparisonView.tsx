import { Button } from '@connor-adams/designsystem'
import { useScenarioComparison } from '../../../hooks/useScenarioComparison';
import { fmtCurrency } from '../util/format';
import {
  Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@connor-adams/designsystem'

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

// NOTE: corp scenarios render blank here — TOTAL_KEYS lists personal line keys only. Pre-existing, out of scope for the restyle (see spec).
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
    <div className="mt-4 rounded-md border border-border">
      <header className="flex items-baseline justify-between px-4 py-3 border-b border-border">
        <h3 className="text-base font-semibold">Comparing {data.length} scenario{data.length === 1 ? '' : 's'}</h3>
        <Button variant="ghost" size="sm" onClick={onClose}>Close</Button>
      </header>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Line</TableHead>
            {data.map((row) => <TableHead key={row.scenario.id}>{row.scenario.name}</TableHead>)}
          </TableRow>
        </TableHeader>
        <TableBody>
          {TOTAL_KEYS.map((k) => (
            <TableRow key={k}>
              <TableCell className="font-medium">{k}</TableCell>
              {data.map((row) => (
                <TableCell key={row.scenario.id} className="text-right tabular-nums">
                  {fmtCurrency(row.computed.totals[k] as string | number | null | undefined)}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
