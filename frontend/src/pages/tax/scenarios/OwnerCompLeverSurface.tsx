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
  useHouseholdPlanCompute, type HouseholdPlanComputeResult, type IntegrationWarning, type PersonalScenarioComputeEntry, } from '@/hooks/useHouseholdPlanCompute';
import { fmtCurrency, fmtPct, numericOrZero, sumNumeric } from '../util/format';
import { StatCard } from '@/components/ui/stat-card';
import {
  Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@connor-adams/designsystem'

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

const OWNER_COMP_KEY_RE =
  /^ownerComp\.(\d+)\.(salary|bonus|eligibleDividend|nonEligibleDividend|capitalDividend)$/;

interface Props {
  corpScenarioId: number;
  corpEntityId: number;
  fiscalYear: number;
  planId: number;
  shareholderEntityIds: number[];
}

type ShareholderRow = Record<FieldKey, number>;
type SliderValues = Record<number, ShareholderRow>;

function emptyShareholderRow(): ShareholderRow {
  return { salary: 0, bonus: 0, eligibleDividend: 0, nonEligibleDividend: 0, capitalDividend: 0 };
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
  for (const id of shareholderIds) out[id] = emptyShareholderRow();
  for (const [k, v] of Object.entries(overrides)) {
    const m = k.match(OWNER_COMP_KEY_RE);
    if (!m) continue;
    const id = Number(m[1]);
    const field = m[2] as FieldKey;
    out[id] = out[id] ?? emptyShareholderRow();
    out[id][field] = numericOrZero(v as string | number | undefined | null);
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
  return Array.from(ids).every((id) => {
    const ra = a[Number(id)];
    const rb = b[Number(id)];
    if (!ra || !rb) return false;
    return FIELDS.every((f) => ra[f.key] === rb[f.key]);
  });
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
        const existing = prev[shareholderId] ?? emptyShareholderRow();
        if (existing[field] === clamped) return prev;
        return { ...prev, [shareholderId]: { ...existing, [field]: clamped } };
      });
    },
    [],
  );

  if (corpDetail.error) {
    return <p className="text-danger">Failed to load corp scenario: {corpDetail.error}</p>;
  }
  if (planCompute.error) {
    return <p className="text-danger">Failed to load household compute: {planCompute.error}</p>;
  }
  if (corpDetail.loading || !corpDetail.data || !values) {
    return <p className="text-muted-foreground">Loading owner comp surface…</p>;
  }

  return (
    <div className="flex flex-col gap-6">
      <header>
        <h3 className="text-lg font-semibold">Owner compensation levers</h3>
        <p className="text-sm text-muted-foreground">
          Slide each lever to see the corp + personal + integrated household tax
          recompute live. Each edit writes an{' '}
          <code>ownerComp.&lt;id&gt;.&lt;field&gt;</code> override on the active
          corp scenario.
        </p>
      </header>

      <div className="flex flex-col gap-4">
        {shareholderEntityIds.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No shareholders linked to this plan yet. Link a personal scenario to
            this household plan to enable owner comp distribution.
          </p>
        ) : (
          shareholderEntityIds.map((shId) => (
            <ShareholderCard
              key={shId}
              shareholderEntityId={shId}
              values={values[shId] ?? emptyShareholderRow()}
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
  values: ShareholderRow;
  onChange: (field: FieldKey, value: number) => void;
}

function ShareholderCard({ shareholderEntityId, values, onChange }: ShareholderCardProps) {
  const total = FIELDS.reduce((sum, f) => sum + (values[f.key] ?? 0), 0);
  return (
    <section className="rounded-md border border-border p-4">
      <header className="mb-3 flex items-baseline justify-between">
        <h4 className="font-medium">Shareholder #{shareholderEntityId}</h4>
        <span className="text-xs text-muted-foreground">Total: {fmtCurrency(total)}</span>
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
        className="rounded border px-2 py-1 text-sm"
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
    return <IntegratedSummaryShell>Computing integrated totals…</IntegratedSummaryShell>;
  }
  if (!data) {
    return <IntegratedSummaryShell>No integrated compute yet.</IntegratedSummaryShell>;
  }
  return <IntegratedSummaryReady data={data} shareholderEntityIds={shareholderEntityIds} />;
}

function IntegratedSummaryShell({ children }: { children: React.ReactNode }) {
  return (
    <section className="rounded-md border border-border p-4">
      <p className="text-sm text-muted-foreground">{children}</p>
    </section>
  );
}

function IntegratedSummaryReady({
  data,
  shareholderEntityIds,
}: {
  data: HouseholdPlanComputeResult;
  shareholderEntityIds: number[];
}) {
  // Aggregate corp totals across all corp scenarios in the plan. v1: assume a
  // single corp; if multiple, we sum (and surface as a single row).
  const corpFederal = sumNumeric(data.corp.map((c) => c.computed.totals.federalTax));
  const corpProvincial = sumNumeric(data.corp.map((c) => c.computed.totals.provincialTax));
  const corpDividendRefund = sumNumeric(data.corp.map((c) => c.computed.totals.dividendRefund));
  const corpNetTax = sumNumeric(data.corp.map((c) => c.computed.totals.netTaxPayable));

  // Per-shareholder rows pulled from `data.personal` (the entity id matches the
  // shareholder id by design). We also pull routed additions from
  // `data.integration.byShareholder` for the employment / dividend display.
  const personalByEntity = new Map<number, PersonalScenarioComputeEntry>(
    data.personal.map((p) => [p.scenario.entityId, p]),
  );

  // Integration row: total earned (gross owner comp routed), total tax (corp
  // net + personal totalPayable), take-home (gross - tax), integrated rate.
  const totalRouted = shareholderEntityIds.reduce(
    (sum, id) => sum + shareholderRoutedTotal(data, id),
    0,
  );
  const personalTotalPayable = sumNumeric(
    Array.from(personalByEntity.values()).map((p) => p.computed.totals.totalPayable),
  );
  const totalTax = corpNetTax + personalTotalPayable;
  const takeHome = totalRouted - totalTax;
  const integratedRate = totalRouted > 0 ? totalTax / totalRouted : NaN;

  return (
    <section className="rounded-md border border-border p-4">
      <h4 className="mb-3 font-medium">Integrated summary</h4>

      <div className="mb-4">
        <h5 className="mb-2 text-sm font-semibold">Corp side</h5>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <StatCard label="T2 federal tax" value={fmtCurrency(corpFederal)} />
          <StatCard label="T2 provincial tax" value={fmtCurrency(corpProvincial)} />
          <StatCard label="Dividend refund" value={fmtCurrency(corpDividendRefund)} />
          <StatCard label="Net corp tax payable" value={fmtCurrency(corpNetTax)} />
        </div>
      </div>

      <div className="mb-4">
        <h5 className="text-sm font-semibold">Personal side</h5>
        {shareholderEntityIds.length === 0 ? (
          <p className="text-xs text-muted-foreground">No shareholders.</p>
        ) : (
          <PersonalSideTable
            data={data}
            shareholderEntityIds={shareholderEntityIds}
            personalByEntity={personalByEntity}
          />
        )}
      </div>

      <div>
        <h5 className="mb-2 text-sm font-semibold">Integration</h5>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <StatCard label="Total routed to shareholders" value={fmtCurrency(totalRouted)} />
          <StatCard label="Total tax (corp + personal)" value={fmtCurrency(totalTax)} />
          <StatCard label="Total take-home" value={fmtCurrency(takeHome)} />
          <StatCard label="Integrated tax rate" value={fmtPct(integratedRate)} />
        </div>
      </div>
    </section>
  );
}

function shareholderRoutedTotal(data: HouseholdPlanComputeResult, id: number): number {
  const a = data.integration.byShareholder[id];
  if (!a) return 0;
  return (
    numericOrZero(a.employmentIncome) +
    numericOrZero(a.eligibleDividends) +
    numericOrZero(a.nonEligibleDividends) +
    numericOrZero(a.capitalDividendsReceived)
  );
}

interface PersonalSideTableProps {
  data: HouseholdPlanComputeResult;
  shareholderEntityIds: number[];
  personalByEntity: Map<number, PersonalScenarioComputeEntry>;
}

function PersonalSideTable({
  data,
  shareholderEntityIds,
  personalByEntity,
}: PersonalSideTableProps) {
  return (
    <Table className="w-full text-sm">
      <TableHeader>
        <TableRow className="text-xs text-muted-foreground">
          <TableHead className="py-1 pr-2">Shareholder</TableHead>
          <TableHead className="py-1 pr-2 text-right">Employment</TableHead>
          <TableHead className="py-1 pr-2 text-right">Dividends</TableHead>
          <TableHead className="py-1 pr-2 text-right">Fed tax</TableHead>
          <TableHead className="py-1 pr-2 text-right">Prov tax</TableHead>
          <TableHead className="py-1 pr-2 text-right">CPP</TableHead>
          <TableHead className="py-1 pr-2 text-right">Net to shareholder</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {shareholderEntityIds.map((id) => (
          <PersonalSideRow
            key={id}
            id={id}
            additions={data.integration.byShareholder[id]}
            personal={personalByEntity.get(id)}
          />
        ))}
      </TableBody>
    </Table>
  );
}

interface PersonalSideRowProps {
  id: number;
  additions: HouseholdPlanComputeResult['integration']['byShareholder'][number] | undefined;
  personal: PersonalScenarioComputeEntry | undefined;
}

function PersonalSideRow({ id, additions, personal }: PersonalSideRowProps) {
  const emp = numericOrZero(additions?.employmentIncome);
  const eligDiv = numericOrZero(additions?.eligibleDividends);
  const nonEligDiv = numericOrZero(additions?.nonEligibleDividends);
  const capDiv = numericOrZero(additions?.capitalDividendsReceived);
  const dividends = eligDiv + nonEligDiv + capDiv;
  const t = personal?.computed.totals ?? {};
  const fedTax = numericOrZero(t.federalTax);
  const provTax = numericOrZero(t.provincialTax);
  const cpp = numericOrZero(t.cppContrib);
  const totalPayable = numericOrZero(t.totalPayable);
  const netToShareholder = emp + dividends - totalPayable;
  return (
    <TableRow>
      <TableCell className="py-1 pr-2">#{id}</TableCell>
      <TableCell className="py-1 pr-2 text-right tabular-nums">{fmtCurrency(emp)}</TableCell>
      <TableCell className="py-1 pr-2 text-right tabular-nums">{fmtCurrency(dividends)}</TableCell>
      <TableCell className="py-1 pr-2 text-right tabular-nums">{fmtCurrency(fedTax)}</TableCell>
      <TableCell className="py-1 pr-2 text-right tabular-nums">{fmtCurrency(provTax)}</TableCell>
      <TableCell className="py-1 pr-2 text-right tabular-nums">{fmtCurrency(cpp)}</TableCell>
      <TableCell className="py-1 pr-2 font-medium text-right tabular-nums">{fmtCurrency(netToShareholder)}</TableCell>
    </TableRow>
  );
}

interface WarningsListProps {
  warnings: IntegrationWarning[];
}

function WarningsList({ warnings }: WarningsListProps) {
  if (warnings.length === 0) return null;
  return (
    <section className="rounded-md border border-warning bg-warning-bg p-4">
      <h4 className="mb-2 font-medium text-warning">
        Integration warnings ({warnings.length})
      </h4>
      <ul className="list-disc pl-5 text-sm text-warning">
        {warnings.map((w, i) => (
          <li key={i}>
            <span className="mr-1 uppercase text-xs">[{w.severity}]</span>
            {w.message}
            {w.shareholderEntityId !== null && (
              <span className="ml-1 text-xs text-warning">
                (shareholder #{w.shareholderEntityId})
              </span>
            )}
            {w.corpScenarioId !== null && (
              <span className="ml-1 text-xs text-warning">
                (corp #{w.corpScenarioId})
              </span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
