// frontend/src/pages/tax/OverviewTab.tsx
//
// Overview tab — first thing the user sees on /tax. Embeds the household plan
// picker at the very top so the active plan id can be selected here and
// reused by `OwnerCompPlannerTab` (state lives in `TaxPage`). When a plan is
// selected, a compact integrated-rate summary card renders alongside the
// existing single-entity totals so the user can compare "personal-only" tax
// against the integrated household number.
import { useTaxReturn } from '../../hooks/useTaxReturn';
import {
  useHouseholdPlanCompute,
  type HouseholdPlanComputeResult,
} from '../../hooks/useHouseholdPlanCompute';
import { HouseholdPlanPicker } from './scenarios/HouseholdPlanPicker';
import { MultiYearCompareCard } from './MultiYearCompareCard';
import { InstalmentTracker } from './InstalmentTracker';

interface Props {
  year: number;
  activePlanId: number | null;
  onPlanChange: (planId: number | null) => void;
}

export function OverviewTab({ year, activePlanId, onPlanChange }: Props) {
  const { data, error, loading } = useTaxReturn(year);
  const planCompute = useHouseholdPlanCompute(activePlanId);

  return (
    <div>
      <section style={{ marginBottom: '1rem' }}>
        <HouseholdPlanPicker activePlanId={activePlanId} onChange={onPlanChange} />
      </section>

      {activePlanId !== null && (
        <section style={{ marginBottom: '1rem' }}>
          <IntegratedRateCard
            loading={planCompute.loading}
            error={planCompute.error}
            data={planCompute.data}
          />
        </section>
      )}

      {loading ? (
        <p className="muted">Computing…</p>
      ) : error ? (
        <p className="error">Error: {error}</p>
      ) : !data ? null : (
        <>
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
          <p className="muted">
            {data.cached ? 'Cached snapshot' : 'Freshly computed'} at{' '}
            {new Date(data.computedAt).toLocaleString()}
          </p>
          <section>
            <MultiYearCompareCard from={year - 2} to={year} />
          </section>
          <section>
            <InstalmentTracker year={year} />
          </section>
        </>
      )}
    </div>
  );
}

interface IntegratedRateCardProps {
  loading: boolean;
  error: string | null;
  data: HouseholdPlanComputeResult | null;
}

/**
 * Compact integrated-rate summary for the active household plan. Sums corp
 * `netTaxPayable` + personal `totalPayable` and divides by the total routed
 * owner-comp gross so the user sees the all-in tax rate at a glance. The
 * detailed per-shareholder breakdown lives on the Owner Comp tab.
 */
function IntegratedRateCard({ loading, error, data }: IntegratedRateCardProps) {
  if (error) {
    return (
      <div className="rounded-md border border-red-300 bg-red-50 p-3">
        <p className="text-sm text-red-700">
          Failed to load integrated household compute: {error}
        </p>
      </div>
    );
  }
  if (loading && !data) {
    return (
      <div className="rounded-md border border-gray-200 p-3">
        <p className="text-sm text-gray-500">Computing integrated household totals…</p>
      </div>
    );
  }
  if (!data) return null;

  const corpNetTax = sumNumeric(data.corp.map((c) => c.computed.totals.netTaxPayable));
  const personalTotalPayable = sumNumeric(
    data.personal.map((p) => p.computed.totals.totalPayable),
  );

  // Total routed = the gross owner-comp money that crossed the integration
  // router. Used as the denominator for the integrated rate.
  const totalRouted = Object.values(data.integration.byShareholder).reduce(
    (sum, add) =>
      sum +
      Number(add.employmentIncome) +
      Number(add.eligibleDividends) +
      Number(add.nonEligibleDividends) +
      Number(add.capitalDividendsReceived),
    0,
  );
  const totalTax = corpNetTax + personalTotalPayable;
  const takeHome = totalRouted - totalTax;
  const integratedRate = totalRouted > 0 ? totalTax / totalRouted : null;
  const warningCount = data.integration.warnings.length;

  return (
    <div className="rounded-md border border-gray-200 p-4">
      <header className="mb-2 flex items-baseline justify-between">
        <h3 className="text-base font-semibold">Integrated household summary</h3>
        <span className="text-xs text-gray-500">
          {data.corp.length} corp · {data.personal.length} personal · {warningCount}{' '}
          warning{warningCount === 1 ? '' : 's'}
        </span>
      </header>
      <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm md:grid-cols-4">
        <Metric label="Total routed" value={fmtCurrency(totalRouted)} />
        <Metric label="Corp net tax" value={fmtCurrency(corpNetTax)} />
        <Metric label="Personal payable" value={fmtCurrency(personalTotalPayable)} />
        <Metric label="Take-home" value={fmtCurrency(takeHome)} strong />
      </div>
      <p className="mt-2 text-sm">
        Integrated tax rate:{' '}
        <strong>{integratedRate === null ? '—' : fmtPct(integratedRate)}</strong>
      </p>
      <p className="muted mt-1 text-xs">
        Tune the salary / dividend mix on the Owner Comp tab — totals here
        refresh on every slider change.
      </p>
    </div>
  );
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

function fmtCurrency(n: number): string {
  if (!Number.isFinite(n)) return '—';
  return `$${n.toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtPct(n: number): string {
  if (!Number.isFinite(n)) return '—';
  return `${(n * 100).toFixed(2)}%`;
}

function sumNumeric(values: Array<string | number | undefined | null>): number {
  let total = 0;
  for (const v of values) {
    if (v === undefined || v === null) continue;
    const n = typeof v === 'number' ? v : Number(v);
    if (Number.isFinite(n)) total += n;
  }
  return total;
}
