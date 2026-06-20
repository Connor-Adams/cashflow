// frontend/src/pages/tax/scenarios/HouseholdRollupCard.tsx
//
// P10 Task 7: plan-level household tax rollup. Sums computed totals across
// every personal entity in the active HouseholdPlan and adds the corp side
// from `planCompute.corp[]` to give the user one number: total household tax.
//
// Per-spouse breakdown shows each personal scenario as a row with its income,
// tax, and (when spouseRouter produced a shift for that entity) a small
// "pension split: −$X" / "+$X" annotation pulled from `planCompute.spouse`.
//
// Style: Tailwind utilities matching `IntegratedRateCard` in OverviewTab.
import type { HouseholdPlanComputeResult, PersonalScenarioComputeEntry, SpouseShift, } from '@/hooks/useHouseholdPlanCompute';
import { fmtCurrency, fmtPct } from '../util/format';
import { StatCard } from '@/components/ui/stat-card';
import {
  Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@connor-adams/designsystem'

interface Props {
  planCompute: HouseholdPlanComputeResult | null;
}

export function HouseholdRollupCard({ planCompute }: Props) {
  if (planCompute === null) {
    return (
      <div className="rounded-md border border-border p-3">
        <p className="text-sm text-muted-foreground">
          Select a household plan to see joint tax rollup.
        </p>
      </div>
    );
  }

  const rollup = deriveRollup(planCompute);
  const spouseCount = planCompute.personal.length;
  const filerLabel = spouseCount === 1 ? 'single-filer' : `${spouseCount} filers`;

  return (
    <div className="rounded-md border border-border p-4">
      <header className="mb-2 flex items-baseline justify-between">
        <h3 className="text-base font-semibold">Household tax rollup</h3>
        <span className="text-xs text-muted-foreground">
          {filerLabel} · {planCompute.corp.length} corp
        </span>
      </header>
      <div className="mb-3 grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard label="Personal payable" value={fmtCurrency(rollup.personalPayable)} />
        <StatCard label="Corp net tax" value={fmtCurrency(rollup.corpNetTax)} />
        <StatCard label="Total household tax" value={fmtCurrency(rollup.totalTax)} />
        <StatCard
          label="Joint effective rate"
          value={rollup.jointRate === null ? '—' : fmtPct(rollup.jointRate)}
        />
      </div>
      <p className="muted mt-1 text-xs">
        Effective rate = total household tax / total personal income (sum of{' '}
        <code>totalIncome</code> across personal scenarios).
      </p>

      {planCompute.personal.length > 0 && (
        <PerSpouseTable
          personal={planCompute.personal}
          spouseByEntityId={planCompute.spouse.byEntityId}
        />
      )}
    </div>
  );
}

interface RollupNumbers {
  personalPayable: number;
  corpNetTax: number;
  totalTax: number;
  totalIncome: number;
  jointRate: number | null;
}

function deriveRollup(data: HouseholdPlanComputeResult): RollupNumbers {
  const personalPayable = sumNumeric(
    data.personal.map((p) => p.computed.totals.totalPayable),
  );
  const corpNetTax = sumNumeric(
    data.corp.map((c) => c.computed.totals.netTaxPayable),
  );
  const totalTax = personalPayable + corpNetTax;
  const totalIncome = sumNumeric(
    data.personal.map((p) => p.computed.totals.totalIncome),
  );
  const jointRate = totalIncome > 0 ? totalTax / totalIncome : null;
  return { personalPayable, corpNetTax, totalTax, totalIncome, jointRate };
}

interface PerSpouseTableProps {
  personal: PersonalScenarioComputeEntry[];
  spouseByEntityId: Record<string, SpouseShift>;
}

function PerSpouseTable({ personal, spouseByEntityId }: PerSpouseTableProps) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Scenario</TableHead>
          <TableHead className="text-right">Total income</TableHead>
          <TableHead className="text-right">Total payable</TableHead>
          <TableHead className="text-right">Pension split</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {personal.map((entry) => {
          const shift = spouseByEntityId[String(entry.scenario.entityId)];
          return (
            <TableRow key={entry.scenario.id}>
              <TableCell>{entry.scenario.name}</TableCell>
              <TableCell className="text-right tabular-nums">
                {fmtCurrency(entry.computed.totals.totalIncome)}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {fmtCurrency(entry.computed.totals.totalPayable)}
              </TableCell>
              <TableCell className="text-right tabular-nums text-xs text-muted-foreground">
                {renderShift(shift)}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

// Render the spouseRouter shift for a single entity, if any. The router emits
// `pensionSplitTransferIn` (positive add) and `pensionSplitTransferOut`
// (positive subtract); display as "+$X" or "−$X" respectively. When an entity
// is both transferor and transferee in a bidirectional split, show both.
function renderShift(shift: SpouseShift | undefined): string {
  if (!shift) return '—';
  const inN = Number(shift.pensionSplitTransferIn);
  const outN = Number(shift.pensionSplitTransferOut);
  const parts: string[] = [];
  if (Number.isFinite(inN) && inN > 0) parts.push(`+${fmtCurrency(inN)}`);
  if (Number.isFinite(outN) && outN > 0) parts.push(`−${fmtCurrency(outN)}`);
  return parts.length === 0 ? '—' : parts.join(' / ');
}

function sumNumeric(values: Array<string | number | undefined | null>): number {
  return values.reduce<number>((acc, v) => {
    if (v == null) return acc;
    const n = typeof v === 'number' ? v : Number(v);
    return Number.isFinite(n) ? acc + n : acc;
  }, 0);
}
