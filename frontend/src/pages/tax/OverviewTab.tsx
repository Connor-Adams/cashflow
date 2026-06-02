// frontend/src/pages/tax/OverviewTab.tsx
//
// Overview tab — first thing the user sees on /tax. Embeds the household plan
// picker at the very top so the active plan id can be selected here and
// reused by `OwnerCompPlannerTab` (state lives in `TaxPage`). When a plan is
// selected, a compact integrated-rate summary card renders alongside the
// existing single-entity totals so the user can compare "personal-only" tax
// against the integrated household number.
//
// P10 T8 wiring: one `<SpouseLinkPicker>` per personal entity in the household
// (top section, before the plan picker) plus `<HouseholdRollupCard>` when a
// plan is active. The rollup card consumes the same `useHouseholdPlanCompute`
// data the integrated-rate card uses, so both refresh on a single fetch.
import { useTaxReturn } from '../../hooks/useTaxReturn';
import {
  useHouseholdPlanCompute,
  type HouseholdPlanComputeResult,
} from '../../hooks/useHouseholdPlanCompute';
import { useTaxEntities } from '../../hooks/useTaxEntities';
import { HouseholdPlanPicker } from './scenarios/HouseholdPlanPicker';
import { HouseholdRollupCard } from './scenarios/HouseholdRollupCard';
import { SpouseLinkPicker } from './scenarios/SpouseLinkPicker';
import { MultiYearCompareCard } from './MultiYearCompareCard';
import { InstalmentTracker } from './InstalmentTracker';
import { fmtCurrency, fmtPct, numericOrZero, sumNumeric } from './util/format';

interface Props {
  year: number;
  activePlanId: number | null;
  onPlanChange: (planId: number | null) => void;
}

export function OverviewTab({ year, activePlanId, onPlanChange }: Props) {
  const { data, error, loading } = useTaxReturn(year);
  const planCompute = useHouseholdPlanCompute(activePlanId);
  const { entities, error: entitiesError, reload: reloadEntities } = useTaxEntities();

  const personalEntities = entities?.filter((e) => e.kind === 'personal') ?? [];

  return (
    <div>
      <section className="mb-4">
        <SpouseLinkSection
          personalEntities={personalEntities}
          allEntities={entities}
          entitiesError={entitiesError}
          onChange={reloadEntities}
        />
      </section>

      <section className="mb-4">
        <HouseholdPlanPicker activePlanId={activePlanId} onChange={onPlanChange} />
      </section>

      {activePlanId !== null && (
        <section className="mb-4">
          <IntegratedRateCard
            loading={planCompute.loading}
            error={planCompute.error}
            data={planCompute.data}
          />
        </section>
      )}

      {activePlanId !== null && (
        <section className="mb-4">
          <HouseholdRollupCard planCompute={planCompute.data} />
        </section>
      )}

      <TaxReturnSection year={year} data={data} loading={loading} error={error} />
    </div>
  );
}

interface SpouseLinkSectionProps {
  personalEntities: Array<{
    id: number;
    legalName: string;
    spouseEntityId: number | null;
  }>;
  allEntities: Array<{ id: number; legalName: string; kind: string }> | null;
  entitiesError: string | null;
  onChange: () => void;
}

// Renders one `<SpouseLinkPicker>` per personal entity so the user can
// link/unlink any of them. Hidden entirely when no personal entities exist
// (the rest of OverviewTab already handles that case via the empty-state
// elsewhere).
function SpouseLinkSection({
  personalEntities,
  allEntities,
  entitiesError,
  onChange,
}: SpouseLinkSectionProps) {
  if (entitiesError) {
    return <p className="error">Failed to load entities: {entitiesError}</p>;
  }
  if (allEntities === null) return <p className="muted">Loading entities…</p>;
  if (personalEntities.length === 0) return null;
  return (
    <div className="rounded-md border border-gray-200 p-3">
      <h3 className="mb-2 text-base font-semibold">Spouse links</h3>
      <ul className="space-y-2">
        {personalEntities.map((entity) => (
          <li key={entity.id}>
            <SpouseLinkPicker
              entity={entity}
              candidateEntities={allEntities}
              onChange={onChange}
            />
          </li>
        ))}
      </ul>
    </div>
  );
}

interface TaxReturnSectionProps {
  year: number;
  data: ReturnType<typeof useTaxReturn>['data'];
  loading: boolean;
  error: string | null;
}

// Renders the year/total/lines block + multi-year + instalments. Pulled out
// of OverviewTab so the parent component is just composition.
function TaxReturnSection({ year, data, loading, error }: TaxReturnSectionProps) {
  if (loading) return <p className="muted">Computing…</p>;
  if (error) return <p className="error">Error: {error}</p>;
  if (!data) return null;
  return (
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
          <ul>
            {data.warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
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
  );
}

interface IntegratedRateCardProps {
  loading: boolean;
  error: string | null;
  data: HouseholdPlanComputeResult | null;
}

type IntegratedRateState =
  | { kind: 'error'; message: string }
  | { kind: 'loading' }
  | { kind: 'empty' }
  | { kind: 'ready'; computed: IntegratedRateComputed; data: HouseholdPlanComputeResult };

interface IntegratedRateComputed {
  corpNetTax: number;
  personalTotalPayable: number;
  totalRouted: number;
  totalTax: number;
  takeHome: number;
  integratedRate: number | null;
  warningCount: number;
}

function deriveIntegratedRate(data: HouseholdPlanComputeResult): IntegratedRateComputed {
  const corpNetTax = sumNumeric(data.corp.map((c) => c.computed.totals.netTaxPayable));
  const personalTotalPayable = sumNumeric(
    data.personal.map((p) => p.computed.totals.totalPayable),
  );
  // Total routed = the gross owner-comp money that crossed the integration
  // router. Used as the denominator for the integrated rate.
  const totalRouted = Object.values(data.integration.byShareholder).reduce(
    (sum, add) =>
      sum +
      numericOrZero(add.employmentIncome) +
      numericOrZero(add.eligibleDividends) +
      numericOrZero(add.nonEligibleDividends) +
      numericOrZero(add.capitalDividendsReceived),
    0,
  );
  const totalTax = corpNetTax + personalTotalPayable;
  const takeHome = totalRouted - totalTax;
  const integratedRate = totalRouted > 0 ? totalTax / totalRouted : null;
  return {
    corpNetTax,
    personalTotalPayable,
    totalRouted,
    totalTax,
    takeHome,
    integratedRate,
    warningCount: data.integration.warnings.length,
  };
}

function integratedRateState({
  loading,
  error,
  data,
}: IntegratedRateCardProps): IntegratedRateState {
  if (error) return { kind: 'error', message: error };
  if (!data) return loading ? { kind: 'loading' } : { kind: 'empty' };
  return { kind: 'ready', data, computed: deriveIntegratedRate(data) };
}

/**
 * Compact integrated-rate summary for the active household plan. Sums corp
 * `netTaxPayable` + personal `totalPayable` and divides by the total routed
 * owner-comp gross so the user sees the all-in tax rate at a glance. The
 * detailed per-shareholder breakdown lives on the Owner Comp tab.
 */
function IntegratedRateCard(props: IntegratedRateCardProps) {
  const state = integratedRateState(props);
  if (state.kind === 'error') {
    return (
      <div className="rounded-md border border-red-300 bg-red-50 p-3">
        <p className="text-sm text-red-700">
          Failed to load integrated household compute: {state.message}
        </p>
      </div>
    );
  }
  if (state.kind === 'loading') {
    return (
      <div className="rounded-md border border-gray-200 p-3">
        <p className="text-sm text-gray-500">Computing integrated household totals…</p>
      </div>
    );
  }
  if (state.kind === 'empty') return null;
  return <IntegratedRateCardReady data={state.data} computed={state.computed} />;
}

interface IntegratedRateCardReadyProps {
  data: HouseholdPlanComputeResult;
  computed: IntegratedRateComputed;
}

function IntegratedRateCardReady({ data, computed }: IntegratedRateCardReadyProps) {
  const {
    corpNetTax,
    personalTotalPayable,
    totalRouted,
    takeHome,
    integratedRate,
    warningCount,
  } = computed;
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
