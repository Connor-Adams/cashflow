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
// Number formatting reuses the same en-CA / 2-decimal pattern from
// `ComparisonView.tsx`'s `formatCell` (re-declared locally so the two cards
// stay independent).
import type {
  HouseholdPlanComputeResult,
  PersonalScenarioComputeEntry,
  SpouseShift,
} from '@/hooks/useHouseholdPlanCompute';

interface Props {
  planCompute: HouseholdPlanComputeResult | null;
}

export function HouseholdRollupCard({ planCompute }: Props) {
  if (planCompute === null) {
    return (
      <div className="rounded-md border border-gray-200 p-3">
        <p className="text-sm text-gray-500">
          Select a household plan to see joint tax rollup.
        </p>
      </div>
    );
  }

  const rollup = deriveRollup(planCompute);
  const spouseCount = planCompute.personal.length;
  const filerLabel = spouseCount === 1 ? 'single-filer' : `${spouseCount} filers`;

  return (
    <div className="rounded-md border border-gray-200 p-4">
      <header className="mb-2 flex items-baseline justify-between">
        <h3 className="text-base font-semibold">Household tax rollup</h3>
        <span className="text-xs text-gray-500">
          {filerLabel} · {planCompute.corp.length} corp
        </span>
      </header>
      <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm md:grid-cols-4">
        <Metric label="Personal payable" value={formatCell(rollup.personalPayable)} />
        <Metric label="Corp net tax" value={formatCell(rollup.corpNetTax)} />
        <Metric label="Total household tax" value={formatCell(rollup.totalTax)} strong />
        <Metric
          label="Joint effective rate"
          value={rollup.jointRate === null ? '—' : formatPct(rollup.jointRate)}
          strong
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
    <table className="mt-3 w-full text-sm">
      <thead>
        <tr className="border-b border-gray-200 text-left">
          <th className="py-1 pr-2 font-medium">Scenario</th>
          <th className="py-1 pr-2 text-right font-medium">Total income</th>
          <th className="py-1 pr-2 text-right font-medium">Total payable</th>
          <th className="py-1 text-right font-medium">Pension split</th>
        </tr>
      </thead>
      <tbody>
        {personal.map((entry) => {
          const shift = spouseByEntityId[String(entry.scenario.entityId)];
          return (
            <tr key={entry.scenario.id} className="border-b border-gray-100 last:border-0">
              <td className="py-1 pr-2">{entry.scenario.name}</td>
              <td className="py-1 pr-2 text-right">
                {formatCell(entry.computed.totals.totalIncome)}
              </td>
              <td className="py-1 pr-2 text-right">
                {formatCell(entry.computed.totals.totalPayable)}
              </td>
              <td className="py-1 text-right text-xs text-gray-500">
                {renderShift(shift)}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
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
  if (Number.isFinite(inN) && inN > 0) parts.push(`+${formatCell(inN)}`);
  if (Number.isFinite(outN) && outN > 0) parts.push(`−${formatCell(outN)}`);
  return parts.length === 0 ? '—' : parts.join(' / ');
}

function Metric({
  label,
  value,
  strong,
}: {
  label: string;
  value: string;
  strong?: boolean;
}) {
  return (
    <div>
      <div className="text-xs text-gray-500">{label}</div>
      <div className={strong ? 'font-semibold' : ''}>{value}</div>
    </div>
  );
}

// Same shape as `formatCell` in `ComparisonView.tsx`: accept string-or-number
// (totals cross the wire as strings) and render with en-CA 2-decimal grouping;
// "—" for null/undefined/non-finite. Re-declared rather than imported so the
// two cards remain independent.
function formatCell(value: unknown): string {
  if (value == null) return '—';
  const n = typeof value === 'string' ? Number(value) : (value as number);
  if (!Number.isFinite(n)) return String(value);
  return n.toLocaleString('en-CA', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function formatPct(n: number): string {
  if (!Number.isFinite(n)) return '—';
  return `${(n * 100).toFixed(2)}%`;
}

function sumNumeric(values: Array<string | number | undefined | null>): number {
  return values.reduce<number>((acc, v) => {
    if (v == null) return acc;
    const n = typeof v === 'number' ? v : Number(v);
    return Number.isFinite(n) ? acc + n : acc;
  }, 0);
}
