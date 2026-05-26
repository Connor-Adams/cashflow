// frontend/src/pages/tax/scenarios/OwnerCompLeverSurface.tsx
//
// Headline UX for P8b: the Owner-Comp lever surface. For each shareholder
// linked to the active household plan, renders five paired slider+number-input
// controls (salary, bonus, eligible div, non-eligible div, capital div). Edits
// hit local state immediately so the UI feels live; a 200ms debounced effect
// then PATCHes `ownerComp.<shareholderEntityId>.<field>` override keys onto
// the active corp scenario and reloads the integrated household plan compute
// so totals refresh.
//
// Layout: one card per shareholder + a single integrated summary card at the
// bottom (corp side / per-shareholder personal side / integration row /
// warnings). Tailwind utilities only.
//
// Data sources:
//  - `useCorpScenarioDetail(corpScenarioId)`  — current overrides + computed totals
//  - `useHouseholdPlanCompute(planId)`        — integrated corp + personal + integration
//  - `useCorpScenarios(corpEntityId, fiscalYear).patch` — writes overrides
//
// Notes:
//  - We re-init local state only when `corpScenarioId` flips. Subsequent
//    reloads of the corp detail (e.g. after our own patch) don't clobber the
//    user's in-flight slider position.
//  - The debounced patch effect skips the first render (no-op for unchanged
//    initial values) by comparing the computed `overrides` blob against the
//    server-known overrides snapshot.
//  - Patch failures are surfaced via `alert(...)`; the surrounding tabs use
//    the same pattern for now.
import { useCallback, useEffect, useRef, useState } from 'react';
import { useCorpScenarioDetail } from '@/hooks/useCorpScenarioDetail';
import { useCorpScenarios } from '@/hooks/useCorpScenarios';
import {
  useHouseholdPlanCompute,
  type HouseholdPlanComputeResult,
  type IntegrationWarning,
  type PersonalScenarioComputeEntry,
} from '@/hooks/useHouseholdPlanCompute';

const FIELDS = [
  { key: 'salary', label: 'Salary' },
  { key: 'bonus', label: 'Bonus' },
  { key: 'eligibleDividend', label: 'Eligible dividend' },
  { key: 'nonEligibleDividend', label: 'Non-eligible dividend' },
  { key: 'capitalDividend', label: 'Capital dividend' },
] as const;

type FieldKey = (typeof FIELDS)[number]['key'];

const SLIDER_MIN = 0;
const SLIDER_MAX = 200_000;
const SLIDER_STEP = 1_000;
const PATCH_DEBOUNCE_MS = 200;

interface Props {
  corpScenarioId: number;
  corpEntityId: number;
  fiscalYear: number;
  planId: number;
  shareholderEntityIds: number[];
}

type SliderValues = Record<number, Record<FieldKey, number>>;

function fmtCurrency(value: string | number | undefined | null): string {
  if (value === undefined || value === null) return '—';
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return '—';
  return `$${n.toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtPct(value: number): string {
  if (!Number.isFinite(value)) return '—';
  return `${(value * 100).toFixed(2)}%`;
}

function ownerCompKey(shareholderId: number, field: FieldKey): string {
  return `ownerComp.${shareholderId}.${field}`;
}

/**
 * Extract the {shareholderId -> {field -> number}} table from a raw
 * overrides bag. Non-matching keys are ignored. Numeric coercion is forgiving:
 * non-finite values fall back to 0 so a borked override never breaks the UI.
 */
function readOwnerCompFromOverrides(
  overrides: Record<string, unknown>,
  shareholderIds: number[],
): SliderValues {
  const out: SliderValues = {};
  for (const id of shareholderIds) {
    out[id] = { salary: 0, bonus: 0, eligibleDividend: 0, nonEligibleDividend: 0, capitalDividend: 0 };
  }
  for (const [k, v] of Object.entries(overrides)) {
    const m = k.match(/^ownerComp\.(\d+)\.(salary|bonus|eligibleDividend|nonEligibleDividend|capitalDividend)$/);
    if (!m) continue;
    const id = Number(m[1]);
    const field = m[2] as FieldKey;
    const n = typeof v === 'number' ? v : Number(v);
    if (!out[id]) {
      out[id] = { salary: 0, bonus: 0, eligibleDividend: 0, nonEligibleDividend: 0, capitalDividend: 0 };
    }
    out[id][field] = Number.isFinite(n) ? n : 0;
  }
  return out;
}

/**
 * Merge an updated owner-comp table back into the full overrides bag. Other
 * (non-owner-comp) keys on the corp scenario are preserved verbatim. Owner
 * comp keys with a 0 value are kept explicit so resets stay sticky on the
 * server (instead of falling back to the previous override value).
 */
function mergeOwnerCompIntoOverrides(
  base: Record<string, unknown>,
  values: SliderValues,
): Record<string, unknown> {
  const next: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(base)) {
    if (!/^ownerComp\.\d+\./.test(k)) next[k] = v;
  }
  for (const [idStr, fields] of Object.entries(values)) {
    const id = Number(idStr);
    for (const field of Object.keys(fields) as FieldKey[]) {
      next[ownerCompKey(id, field)] = fields[field];
    }
  }
  return next;
}

function sliderValuesEqual(a: SliderValues, b: SliderValues): boolean {
  const ids = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const id of ids) {
    const ra = a[Number(id)];
    const rb = b[Number(id)];
    if (!ra || !rb) return false;
    for (const field of FIELDS) {
      if (ra[field.key] !== rb[field.key]) return false;
    }
  }
  return true;
}

export function OwnerCompLeverSurface({
  corpScenarioId,
  corpEntityId,
  fiscalYear,
  planId,
  shareholderEntityIds,
}: Props) {
  const corpDetail = useCorpScenarioDetail(corpScenarioId);
  const planCompute = useHouseholdPlanCompute(planId);
  const { patch } = useCorpScenarios(corpEntityId, fiscalYear);

  // Local slider state — initialised from the corp scenario detail when it
  // first arrives (or when the corp scenario id changes). Subsequent corp
  // detail reloads (caused by our own patch) MUST NOT clobber the in-flight
  // edits the user has made, so we only re-init when `corpScenarioId` flips.
  const [values, setValues] = useState<SliderValues | null>(null);
  const [serverSnapshot, setServerSnapshot] = useState<SliderValues | null>(null);
  const initForScenarioRef = useRef<number | null>(null);

  useEffect(() => {
    if (!corpDetail.data) return;
    if (initForScenarioRef.current === corpScenarioId) return;
    const seeded = readOwnerCompFromOverrides(
      corpDetail.data.scenario.overrides,
      shareholderEntityIds,
    );
    setValues(seeded);
    setServerSnapshot(seeded);
    initForScenarioRef.current = corpScenarioId;
  }, [corpDetail.data, corpScenarioId, shareholderEntityIds]);

  // Debounced patch effect — fires 200ms after the user stops dragging.
  // Skips when `values` matches the last-known server snapshot so we don't
  // hit the wire on a no-op (e.g. on first render after the seed).
  const debounceRef = useRef<number | null>(null);
  useEffect(() => {
    if (!values || !serverSnapshot) return;
    if (!corpDetail.data) return;
    if (sliderValuesEqual(values, serverSnapshot)) return;

    if (debounceRef.current !== null) window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(() => {
      const snapshotAtSchedule = values;
      const nextOverrides = mergeOwnerCompIntoOverrides(
        corpDetail.data!.scenario.overrides,
        snapshotAtSchedule,
      );
      patch(corpScenarioId, { overrides: nextOverrides })
        .then(() => {
          setServerSnapshot(snapshotAtSchedule);
          corpDetail.reload();
          planCompute.reload();
        })
        .catch((err: unknown) => {
          alert(`Failed to apply owner comp change: ${(err as Error).message}`);
        });
    }, PATCH_DEBOUNCE_MS);

    return () => {
      if (debounceRef.current !== null) window.clearTimeout(debounceRef.current);
    };
  }, [values, serverSnapshot, corpDetail, corpScenarioId, patch, planCompute]);

  const handleFieldChange = useCallback(
    (shareholderId: number, field: FieldKey, raw: number) => {
      const clamped = Number.isFinite(raw) ? Math.max(0, raw) : 0;
      setValues((prev) => {
        if (!prev) return prev;
        const existing = prev[shareholderId] ?? {
          salary: 0,
          bonus: 0,
          eligibleDividend: 0,
          nonEligibleDividend: 0,
          capitalDividend: 0,
        };
        if (existing[field] === clamped) return prev;
        return { ...prev, [shareholderId]: { ...existing, [field]: clamped } };
      });
    },
    [],
  );

  if (corpDetail.error) {
    return (
      <p className="text-red-600">Failed to load corp scenario: {corpDetail.error}</p>
    );
  }
  if (planCompute.error) {
    return (
      <p className="text-red-600">Failed to load household compute: {planCompute.error}</p>
    );
  }
  if (corpDetail.loading || !corpDetail.data || !values) {
    return <p className="text-gray-500">Loading owner comp surface…</p>;
  }

  return (
    <div className="flex flex-col gap-6">
      <header>
        <h3 className="text-lg font-semibold">Owner compensation levers</h3>
        <p className="text-sm text-gray-500">
          Slide each lever to see the corp + personal + integrated household tax
          recompute live. Each edit writes an{' '}
          <code>ownerComp.&lt;id&gt;.&lt;field&gt;</code> override on the active
          corp scenario.
        </p>
      </header>

      <div className="flex flex-col gap-4">
        {shareholderEntityIds.length === 0 ? (
          <p className="text-sm text-gray-500">
            No shareholders linked to this plan yet. Link a personal scenario to
            this household plan to enable owner comp distribution.
          </p>
        ) : (
          shareholderEntityIds.map((shId) => (
            <ShareholderCard
              key={shId}
              shareholderEntityId={shId}
              values={
                values[shId] ?? {
                  salary: 0,
                  bonus: 0,
                  eligibleDividend: 0,
                  nonEligibleDividend: 0,
                  capitalDividend: 0,
                }
              }
              onChange={(field, value) => handleFieldChange(shId, field, value)}
            />
          ))
        )}
      </div>

      <IntegratedSummary
        loading={planCompute.loading}
        data={planCompute.data}
        shareholderEntityIds={shareholderEntityIds}
      />

      <WarningsList warnings={planCompute.data?.integration.warnings ?? []} />
    </div>
  );
}

interface ShareholderCardProps {
  shareholderEntityId: number;
  values: Record<FieldKey, number>;
  onChange: (field: FieldKey, value: number) => void;
}

function ShareholderCard({ shareholderEntityId, values, onChange }: ShareholderCardProps) {
  return (
    <section className="rounded-md border border-gray-200 p-4">
      <header className="mb-3 flex items-baseline justify-between">
        <h4 className="font-medium">Shareholder #{shareholderEntityId}</h4>
        <span className="text-xs text-gray-500">
          Total:{' '}
          {fmtCurrency(
            FIELDS.reduce((sum, f) => sum + (values[f.key] ?? 0), 0),
          )}
        </span>
      </header>
      <div className="flex flex-col gap-2">
        {FIELDS.map((f) => (
          <SliderRow
            key={f.key}
            label={f.label}
            value={values[f.key] ?? 0}
            onChange={(next) => onChange(f.key, next)}
          />
        ))}
      </div>
    </section>
  );
}

interface SliderRowProps {
  label: string;
  value: number;
  onChange: (next: number) => void;
}

function SliderRow({ label, value, onChange }: SliderRowProps) {
  return (
    <div className="grid grid-cols-[10rem_1fr_8rem] items-center gap-3">
      <label className="text-sm">{label}</label>
      <input
        type="range"
        min={SLIDER_MIN}
        max={SLIDER_MAX}
        step={SLIDER_STEP}
        value={Math.min(SLIDER_MAX, Math.max(SLIDER_MIN, value))}
        onChange={(e) => onChange(Number(e.target.value))}
        aria-label={`${label} slider`}
      />
      <input
        type="number"
        min={0}
        step={1}
        value={value}
        onChange={(e) => {
          const n = Number(e.target.value);
          onChange(Number.isFinite(n) ? n : 0);
        }}
        className="rounded border border-gray-300 px-2 py-1 text-sm"
        aria-label={`${label} amount`}
      />
    </div>
  );
}

interface IntegratedSummaryProps {
  loading: boolean;
  data: HouseholdPlanComputeResult | null;
  shareholderEntityIds: number[];
}

function IntegratedSummary({ loading, data, shareholderEntityIds }: IntegratedSummaryProps) {
  if (loading && !data) {
    return (
      <section className="rounded-md border border-gray-200 p-4">
        <p className="text-sm text-gray-500">Computing integrated totals…</p>
      </section>
    );
  }
  if (!data) {
    return (
      <section className="rounded-md border border-gray-200 p-4">
        <p className="text-sm text-gray-500">No integrated compute yet.</p>
      </section>
    );
  }

  // Aggregate corp totals across all corp scenarios in the plan. v1: assume a
  // single corp; if multiple, we sum (and surface as a single row).
  const corpFederal = sumStrings(data.corp.map((c) => c.computed.totals.federalTax));
  const corpProvincial = sumStrings(data.corp.map((c) => c.computed.totals.provincialTax));
  const corpDividendRefund = sumStrings(data.corp.map((c) => c.computed.totals.dividendRefund));
  const corpNetTax = sumStrings(data.corp.map((c) => c.computed.totals.netTaxPayable));

  // Per-shareholder rows pulled from `data.personal` (the entity id matches the
  // shareholder id by design). We also pull routed additions from
  // `data.integration.byShareholder` for the employment / dividend display.
  const personalByEntity = new Map<number, PersonalScenarioComputeEntry>(
    data.personal.map((p) => [p.scenario.entityId, p]),
  );

  // Integration row: total earned (gross owner comp routed), total tax (corp
  // net + personal totalPayable), take-home (gross - tax), integrated rate.
  const totalRouted = shareholderEntityIds.reduce((sum, id) => {
    const a = data.integration.byShareholder[id];
    if (!a) return sum;
    return (
      sum +
      Number(a.employmentIncome) +
      Number(a.eligibleDividends) +
      Number(a.nonEligibleDividends) +
      Number(a.capitalDividendsReceived)
    );
  }, 0);
  const personalTotalPayable = sumStrings(
    Array.from(personalByEntity.values()).map(
      (p) => p.computed.totals.totalPayable as string | number | undefined,
    ),
  );
  const totalTax = corpNetTax + personalTotalPayable;
  const takeHome = totalRouted - totalTax;
  const integratedRate = totalRouted > 0 ? totalTax / totalRouted : NaN;

  return (
    <section className="rounded-md border border-gray-200 p-4">
      <h4 className="mb-3 font-medium">Integrated summary</h4>

      <div className="mb-4">
        <h5 className="text-sm font-semibold">Corp side</h5>
        <table className="w-full text-sm">
          <tbody>
            <SummaryRow label="T2 federal tax" value={fmtCurrency(corpFederal)} />
            <SummaryRow label="T2 provincial tax" value={fmtCurrency(corpProvincial)} />
            <SummaryRow label="Dividend refund" value={fmtCurrency(corpDividendRefund)} />
            <SummaryRow
              label="Net corp tax payable"
              value={fmtCurrency(corpNetTax)}
              strong
            />
          </tbody>
        </table>
      </div>

      <div className="mb-4">
        <h5 className="text-sm font-semibold">Personal side</h5>
        {shareholderEntityIds.length === 0 ? (
          <p className="text-xs text-gray-500">No shareholders.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-gray-500">
                <th className="py-1 pr-2">Shareholder</th>
                <th className="py-1 pr-2">Employment</th>
                <th className="py-1 pr-2">Dividends</th>
                <th className="py-1 pr-2">Fed tax</th>
                <th className="py-1 pr-2">Prov tax</th>
                <th className="py-1 pr-2">CPP</th>
                <th className="py-1 pr-2">Net to shareholder</th>
              </tr>
            </thead>
            <tbody>
              {shareholderEntityIds.map((id) => {
                const additions = data.integration.byShareholder[id];
                const personal = personalByEntity.get(id);
                const emp = additions ? Number(additions.employmentIncome) : 0;
                const eligDiv = additions ? Number(additions.eligibleDividends) : 0;
                const nonEligDiv = additions ? Number(additions.nonEligibleDividends) : 0;
                const capDiv = additions ? Number(additions.capitalDividendsReceived) : 0;
                const dividends = eligDiv + nonEligDiv + capDiv;
                const t = personal?.computed.totals ?? {};
                const fedTax = numericTotal(t.federalTax);
                const provTax = numericTotal(t.provincialTax);
                const cpp = numericTotal(t.cppContrib);
                const totalPayable = numericTotal(t.totalPayable);
                const netToShareholder = emp + dividends - totalPayable;
                return (
                  <tr key={id}>
                    <td className="py-1 pr-2">#{id}</td>
                    <td className="py-1 pr-2">{fmtCurrency(emp)}</td>
                    <td className="py-1 pr-2">{fmtCurrency(dividends)}</td>
                    <td className="py-1 pr-2">{fmtCurrency(fedTax)}</td>
                    <td className="py-1 pr-2">{fmtCurrency(provTax)}</td>
                    <td className="py-1 pr-2">{fmtCurrency(cpp)}</td>
                    <td className="py-1 pr-2 font-medium">{fmtCurrency(netToShareholder)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      <div>
        <h5 className="text-sm font-semibold">Integration</h5>
        <table className="w-full text-sm">
          <tbody>
            <SummaryRow label="Total routed to shareholders" value={fmtCurrency(totalRouted)} />
            <SummaryRow label="Total tax (corp + personal)" value={fmtCurrency(totalTax)} />
            <SummaryRow label="Total take-home" value={fmtCurrency(takeHome)} strong />
            <SummaryRow label="Integrated tax rate" value={fmtPct(integratedRate)} strong />
          </tbody>
        </table>
      </div>
    </section>
  );
}

interface SummaryRowProps {
  label: string;
  value: string;
  strong?: boolean;
}

function SummaryRow({ label, value, strong }: SummaryRowProps) {
  return (
    <tr>
      <td className="py-1 pr-4 text-gray-600">{label}</td>
      <td className={`py-1 ${strong ? 'font-semibold' : ''}`}>{value}</td>
    </tr>
  );
}

interface WarningsListProps {
  warnings: IntegrationWarning[];
}

function WarningsList({ warnings }: WarningsListProps) {
  if (warnings.length === 0) return null;
  return (
    <section className="rounded-md border border-amber-300 bg-amber-50 p-4">
      <h4 className="mb-2 font-medium text-amber-900">
        Integration warnings ({warnings.length})
      </h4>
      <ul className="list-disc pl-5 text-sm text-amber-900">
        {warnings.map((w, i) => (
          <li key={i}>
            <span className="mr-1 uppercase text-xs">[{w.severity}]</span>
            {w.message}
            {w.shareholderEntityId !== null && (
              <span className="ml-1 text-xs text-amber-700">
                (shareholder #{w.shareholderEntityId})
              </span>
            )}
            {w.corpScenarioId !== null && (
              <span className="ml-1 text-xs text-amber-700">
                (corp #{w.corpScenarioId})
              </span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

function sumStrings(values: Array<string | number | undefined | null>): number {
  let total = 0;
  for (const v of values) {
    if (v === undefined || v === null) continue;
    const n = typeof v === 'number' ? v : Number(v);
    if (Number.isFinite(n)) total += n;
  }
  return total;
}

function numericTotal(v: string | number | undefined): number {
  if (v === undefined || v === null) return 0;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}
