import { useCallback, useEffect, useState } from 'react';
import { useTaxEntities, type TaxEntity } from '../../hooks/useTaxEntities';
import {
  useCorpScenarios, type CorpScenarioWithComputed, } from '../../hooks/useCorpScenarios';
import { useCorpScenarioDetail } from '../../hooks/useCorpScenarioDetail';
import { useCorpScenarioChain } from '../../hooks/useCorpScenarioChain';
import { type CorpTaxLineDto } from '../../hooks/useCorpReturn';
import { ScenarioTree } from './scenarios/ScenarioTree';
import { CorpOverrideEditor, type OtherCorpOption } from './scenarios/CorpOverrideEditor';
import { ComparisonView } from './scenarios/ComparisonView';
import { YearStripNav } from './scenarios/YearStripNav';
import { useStarterScenario } from './scenarios/useStarterScenario';
import { AssumptionsEditor } from './scenarios/AssumptionsEditor';
import type { Scenario } from '../../hooks/useScenarios';
import { patchJson } from '../../lib/api';
import { fmtCurrency } from './util/format';
import { labelForTotal } from './util/labels';
import { TaxLineBreakdownTable } from './components/TaxLineBreakdownTable';
import { ScenarioCompareBar } from './components/ScenarioCompareBar';
import { Button } from '@connor-adams/designsystem'
import { StatCard } from '@connor-adams/designsystem';
import { Card } from '@connor-adams/designsystem'
import { CollapsibleCard } from '@/components/ui/collapsible-card';
import { Alert } from '@connor-adams/designsystem'
import { EmptyState } from '@connor-adams/designsystem'

interface CorpT2TabProps {
  /** The Tax page's selected year; corp scenarios are keyed by its start year. */
  year: number;
}

export function CorpT2Tab({ year }: CorpT2TabProps) {
  const { entities, error: entitiesError, reload: reloadEntities } = useTaxEntities();

  if (entitiesError) {
    return (
      <div>
        <h2>Corp T2</h2>
        <p className="error">Failed to load entities: {entitiesError}</p>
      </div>
    );
  }
  if (entities === null) {
    return (
      <div>
        <h2>Corp T2</h2>
        <p className="muted">Loading entities…</p>
      </div>
    );
  }

  const corpEntity = entities.find((e) => e.kind === 'corp');
  // Other corp entities in the household, surfaced to CorpOverrideEditor so
  // users can pick intercorp dividend recipients by legal name instead of
  // entity id. P11a v1 doesn't filter by "in active HouseholdPlan" — the
  // backend router validates plan membership and warns at compute time.
  const otherCorps: OtherCorpOption[] = corpEntity
    ? entities
        .filter((e) => e.kind === 'corp' && e.id !== corpEntity.id)
        .map((e) => ({ id: e.id, legalName: e.legalName }))
    : [];

  return (
    <div>
      <header className="mb-3">
        <h2>Corp T2 — {year}</h2>
        <p className="muted">
          Each scenario layers overrides on top of actuals. Edit overrides on
          the right to see recomputed totals; add scenarios to the compare bar
          to see them side-by-side.
        </p>
      </header>
      {!corpEntity ? (
        <EmptyState
          title="No corporation yet"
          description="Add a corporate entity to model its T2 return."
        />
      ) : (
        <>
          <AssociatedGroupInput corpEntity={corpEntity} onSaved={reloadEntities} />
          <CorpT2ScenarioWorkspace
            key={`${corpEntity.id}:${year}`}
            entityId={corpEntity.id}
            year={year}
            otherCorps={otherCorps}
          />
        </>
      )}
    </div>
  );
}

interface AssociatedGroupInputProps {
  corpEntity: TaxEntity;
  onSaved: () => void;
}

/**
 * Free-text input bound to `corpEntity.associatedGroupId`. Commits on blur or
 * Enter via PATCH /api/tax/entities/:id. Corps sharing the same string are
 * treated as an associated group for the shared $500k SBD limit + $50k AAII
 * threshold (P11b T1-T3).
 *
 * v1 UI choice: free-text rather than a dropdown of existing group ids — the
 * graph of "which corps are grouped" is small enough that typing the same
 * tag in two corps is faster than scaffolding a separate picker.
 */
function AssociatedGroupInput({ corpEntity, onSaved }: AssociatedGroupInputProps) {
  // Local state mirrors the server value so the input is fully controlled and
  // doesn't reset mid-typing; commit on blur or Enter then reload entities.
  const [draft, setDraft] = useState<string>(corpEntity.associatedGroupId ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Re-seed the draft when the active corp changes (or its persisted group
  // updates from outside) so the input stays in sync with server truth.
  useEffect(() => {
    setDraft(corpEntity.associatedGroupId ?? '');
  }, [corpEntity.id, corpEntity.associatedGroupId]);

  async function commit() {
    const trimmed = draft.trim();
    const next = trimmed === '' ? null : trimmed;
    // No-op if unchanged — avoids spurious PATCH on every blur.
    if (next === (corpEntity.associatedGroupId ?? null)) return;
    setSaving(true);
    setError(null);
    try {
      await patchJson(`/api/tax/entities/${corpEntity.id}`, {
        associatedGroupId: next,
      });
      onSaved();
    } catch (err: unknown) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mb-3">
      <label>
        Associated group{' '}
        <input
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
          placeholder="e.g. ABCorp (blank = no group)"
          disabled={saving}
          className="w-64"
        />
      </label>
      {saving && <span className="muted ml-2">Saving…</span>}
      {error && <span className="error ml-2">Failed: {error}</span>}
      <p className="muted mt-1">
        Corps sharing the same group tag share a $500k SBD limit and $50k AAII
        threshold. Leave blank for unaffiliated corps.
      </p>
    </div>
  );
}

interface WorkspaceProps {
  entityId: number;
  year: number;
  otherCorps: OtherCorpOption[];
}

function CorpT2ScenarioWorkspace({ entityId, year: yearProp, otherCorps }: WorkspaceProps) {
  // Local `selectedYear` overlays the prop so the YearStripNav can pivot to a
  // chained year (year+1 projection, etc.) without round-tripping through
  // the page's year picker. The parent keys this component on the year, so a
  // new page year remounts it with fresh state.
  const [selectedYear, setSelectedYear] = useState(yearProp);

  const {
    scenarios,
    loading,
    error,
    create,
    patch,
    fork,
    remove,
    projectNextYear,
  } = useCorpScenarios(entityId, selectedYear);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [compareIds, setCompareIds] = useState<number[]>([]);
  const [isProjecting, setIsProjecting] = useState(false);

  // The POST handler auto-creates the baseline as parent + a fork named
  // "Scratch" as the leaf. Same bootstrap as PersonalT1Tab.
  const createStarter = useCallback(() => create({ name: 'Scratch', overrides: {} }), [create]);
  const starterError = useStarterScenario({
    key: `${entityId}:${selectedYear}`,
    loading,
    empty: scenarios.length === 0,
    create: createStarter,
  });

  // Auto-select the most-recently-created leaf so the detail pane has content
  // as soon as the bootstrap POST resolves (or the user logs in to an existing
  // tree). Picks the latest fork if any, otherwise falls back to the baseline.
  useEffect(() => {
    if (activeId !== null || loading) return;
    if (scenarios.length === 0) return;
    const latestFork = [...scenarios]
      .reverse()
      .find((s) => s.kind !== 'baseline');
    setActiveId((latestFork ?? scenarios[0]).id);
  }, [activeId, loading, scenarios]);

  // Prune deleted scenarios from the compare set so the comparison view never
  // requests a stale id (the backend would 404 the whole compare).
  useEffect(() => {
    const liveIds = new Set(scenarios.map((s) => s.id));
    setCompareIds((prev) => {
      const filtered = prev.filter((id) => liveIds.has(id));
      return filtered.length === prev.length ? prev : filtered;
    });
  }, [scenarios]);

  const active = useCorpScenarioDetail(activeId);
  // Walk the multi-year chain forward from whichever scenario is active. The
  // backend resolves to the chain root, so passing any chained scenario id
  // returns the same year-ordered list.
  const chain = useCorpScenarioChain(activeId);

  async function handleProjectNextYear() {
    if (activeId === null) return;
    setIsProjecting(true);
    try {
      const next = await projectNextYear(activeId);
      // Re-key the scenarios query to the new year and select the new
      // projection_root. The chain hook will re-fetch via its own effect once
      // activeId flips.
      setSelectedYear(next.year);
      setActiveId(next.id);
      chain.reload();
    } catch (err: unknown) {
      alert((err as Error).message);
    } finally {
      setIsProjecting(false);
    }
  }

  function handleSelectYear(_year: number, scenarioId: number) {
    // The chain entry carries the canonical year-N scenario id; switching
    // years means swapping both the year key (so useCorpScenarios refetches
    // the right list) and the active scenario id (so the detail pane updates).
    setSelectedYear(_year);
    setActiveId(scenarioId);
  }

  async function handleAssumptionsChange(next: {
    inflation?: number;
    investmentReturn?: number;
  }) {
    if (!active.data) return;
    try {
      // patch's `assumptions` field is typed loosely (Record<string, unknown>);
      // narrow assumption shape is owned by AssumptionsEditor + the projection
      // builders. Cast at the boundary, not throughout the component tree.
      await patch(active.data.scenario.id, {
        assumptions: next as Record<string, unknown>,
      });
      active.reload();
      chain.reload();
    } catch (err: unknown) {
      alert((err as Error).message);
    }
  }

  async function handleForkActive() {
    if (activeId === null) return;
    try {
      const child = await fork(activeId);
      setActiveId(child.id);
    } catch (err: unknown) {
      alert((err as Error).message);
    }
  }

  async function handleDeleteActive() {
    if (activeId === null) return;
    try {
      await remove(activeId);
      setActiveId(null);
    } catch (err: unknown) {
      alert((err as Error).message);
    }
  }

  async function handleOverridesChange(next: Record<string, unknown>) {
    if (!active.data) return;
    try {
      await patch(active.data.scenario.id, { overrides: next });
      active.reload();
    } catch (err: unknown) {
      alert((err as Error).message);
    }
  }

  function toggleCompare(id: number) {
    setCompareIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  }

  if (loading) return <p className="muted">Loading scenarios…</p>;
  if (error) return <p className="error">Failed to load scenarios: {error}</p>;
  if (starterError && scenarios.length === 0) {
    return <p className="error">Failed to create a starter scenario: {starterError}</p>;
  }

  return (
    <div>
      <div className="mb-3">
        <YearStripNav
          entityId={entityId}
          activeYear={selectedYear}
          activeScenarioId={activeId}
          chain={chain.data ?? []}
          onSelectYear={handleSelectYear}
          onProjectNextYear={handleProjectNextYear}
          isProjecting={isProjecting}
        />
        {chain.error && (
          <p className="error mt-1">
            Failed to load year chain: {chain.error}
          </p>
        )}
      </div>
      <div className="flex flex-col md:flex-row gap-6">
        <div className="md:w-64 md:flex-shrink-0">
          {/* ScenarioTree is entity-kind agnostic — CorpScenario and Scenario
              share the same shape so the cast is safe. */}
          <ScenarioTree
            scenarios={scenarios as unknown as Scenario[]}
            activeId={activeId}
            onSelect={setActiveId}
            onForkActive={handleForkActive}
            onDeleteActive={handleDeleteActive}
          />
        </div>
        <div className="flex-1 min-w-0">
          {activeId === null ? (
            <p className="muted">Select a scenario to view details.</p>
          ) : active.loading ? (
            <p className="muted">Loading scenario…</p>
          ) : active.error ? (
            <p className="error">Failed to load scenario: {active.error}</p>
          ) : active.data ? (
            <ActiveCorpScenarioPanel
              data={active.data}
              otherCorps={otherCorps}
              onOverridesChange={handleOverridesChange}
              onAssumptionsChange={handleAssumptionsChange}
              onAddToCompare={() => toggleCompare(active.data!.scenario.id)}
              inCompare={compareIds.includes(active.data.scenario.id)}
            />
          ) : null}
          {compareIds.length > 0 && (
            <ScenarioCompareBar
              ids={compareIds}
              scenarios={scenarios}
              onRemove={toggleCompare}
              onClear={() => setCompareIds([])}
            />
          )}
          {compareIds.length > 1 && (
            <ComparisonView
              ids={compareIds}
              onClose={() => setCompareIds([])}
              endpoint="/api/tax/scenarios/corp/compare"
            />
          )}
        </div>
      </div>
    </div>
  );
}

interface ActiveCorpScenarioPanelProps {
  data: CorpScenarioWithComputed;
  otherCorps: OtherCorpOption[];
  onOverridesChange: (next: Record<string, unknown>) => void;
  onAssumptionsChange: (next: { inflation?: number; investmentReturn?: number }) => void;
  onAddToCompare: () => void;
  inCompare: boolean;
}

function ActiveCorpScenarioPanel({
  data,
  otherCorps,
  onOverridesChange,
  onAssumptionsChange,
  onAddToCompare,
  inCompare,
}: ActiveCorpScenarioPanelProps) {
  const { scenario, computed } = data;
  // Backend serialises Decimal via toJSON → string, matching CorpTaxLineDto.
  // The computed lines come back through JSON.parse(JSON.stringify(...))
  // which collapses Decimal instances to their string form (see
  // computeCorpScenario).
  const lines = (computed.lines ?? []) as CorpTaxLineDto[];
  const isProjection = scenario.kind === 'projection_root';
  return (
    <div>
      <header className="mb-3 flex items-baseline gap-3">
        <h3 className="m-0">{scenario.name}</h3>
        <span className="muted">
          {scenario.kind === 'baseline' ? 'baseline (actuals)' : scenario.kind}
        </span>
        <Button variant="secondary" size="sm" onClick={onAddToCompare} className="ml-auto">
          {inCompare ? '✓ In compare' : '+ Add to compare'}
        </Button>
      </header>
      {isProjection && (
        <div className="mb-3">
          <AssumptionsEditor
            assumptions={scenario.assumptions as { inflation?: number; investmentReturn?: number }}
            onChange={onAssumptionsChange}
          />
        </div>
      )}
      <CorpOverrideEditor
        overrides={scenario.overrides}
        onChange={onOverridesChange}
        otherCorps={otherCorps}
      />

      {/* Headline — 4 most decision-relevant corp totals:
          1. netTaxPayable  — the bottom line; primary planning target
          2. taxableIncome  — feeds all rate calculations
          3. activeBusinessIncome — shows SBD eligibility context
          4. dividendRefund — actionable: drives when to pay dividends */}
      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard label="Net tax payable" value={fmtCurrency(computed.totals.netTaxPayable)} />
        <StatCard label="Taxable income" value={fmtCurrency(computed.totals.taxableIncome)} />
        <StatCard label="Active business income" value={fmtCurrency(computed.totals.activeBusinessIncome)} />
        <StatCard label="Dividend refund" value={fmtCurrency(computed.totals.dividendRefund)} />
      </div>

      {/* All totals, humanized */}
      <Card className="mb-4">
        <h4 className="mb-2 text-sm font-semibold">Computed totals</h4>
        <dl className="grid grid-cols-1 gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
          {Object.entries(computed.totals).map(([k, v]) => (
            <div key={k} className="flex justify-between">
              <dt className="text-muted-foreground">{labelForTotal(k)}</dt>
              <dd className="tabular-nums">{fmtCurrency(v as string)}</dd>
            </div>
          ))}
        </dl>
        <p className="muted mt-2 text-xs">
          {computed.cached ? 'Cached snapshot' : 'Freshly computed'} at{' '}
          {new Date(computed.computedAt).toLocaleString()}
        </p>
      </Card>

      {computed.warnings.length > 0 && (
        <Alert variant="warning" title="Warnings" className="mb-4">
          <ul className="m-0 list-disc pl-5">
            {computed.warnings.map((w, i) => <li key={i}>{w}</li>)}
          </ul>
        </Alert>
      )}

      <CollapsibleCard title="Return detail (T2 lines)" defaultOpen={false}>
        <TaxLineBreakdownTable lines={lines} />
      </CollapsibleCard>
    </div>
  );
}
