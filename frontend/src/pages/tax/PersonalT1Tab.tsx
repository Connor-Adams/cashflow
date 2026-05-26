import { useEffect, useState } from 'react';
import { useTaxEntities } from '../../hooks/useTaxEntities';
import {
  useScenarios,
  useScenarioDetail,
  type Scenario,
  type ScenarioWithComputed,
} from '../../hooks/useScenarios';
import { useScenarioChain } from '../../hooks/useScenarioChain';
import { type TaxLineDto } from '../../hooks/useTaxReturn';
import { ScenarioTree } from './scenarios/ScenarioTree';
import { OverrideEditor } from './scenarios/OverrideEditor';
import { ComparisonView } from './scenarios/ComparisonView';
import { YearStripNav } from './scenarios/YearStripNav';
import { AssumptionsEditor } from './scenarios/AssumptionsEditor';
import { RrifMinCalc } from './scenarios/RrifMinCalc';

export function PersonalT1Tab({ year }: { year: number }) {
  const { entities, error: entitiesError } = useTaxEntities();

  if (entitiesError) return <p className="error">Failed to load entities: {entitiesError}</p>;
  if (entities === null) return <p className="muted">Loading entities…</p>;

  const personalEntity = entities.find((e) => e.kind === 'personal');
  if (!personalEntity) {
    return (
      <p className="muted">
        No personal entity for this household. Create one first (POST /api/tax/entities).
      </p>
    );
  }

  return <PersonalT1ScenarioWorkspace year={year} entityId={personalEntity.id} />;
}

interface WorkspaceProps {
  year: number;
  entityId: number;
}

function PersonalT1ScenarioWorkspace({ year: yearProp, entityId }: WorkspaceProps) {
  // Local `selectedYear` overlays the prop so the YearStripNav can pivot to a
  // chained year (year+1 projection, etc.) without round-tripping through
  // TaxPage's year selector. When the prop changes (user picks a year in the
  // top-level selector) we re-seed local state to match.
  const [selectedYear, setSelectedYear] = useState(yearProp);
  useEffect(() => { setSelectedYear(yearProp); }, [yearProp]);

  const {
    scenarios,
    loading,
    error,
    create,
    patch,
    fork,
    remove,
    projectNextYear,
  } = useScenarios(entityId, selectedYear);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [compareIds, setCompareIds] = useState<number[]>([]);
  const [bootstrapping, setBootstrapping] = useState(false);
  const [isProjecting, setIsProjecting] = useState(false);

  // Auto-create a starter scenario on first load so the baseline materialises
  // and there is something for the user to edit immediately. The POST handler
  // auto-creates the baseline as parent + a fork named "Scratch" as the leaf.
  useEffect(() => {
    if (loading || bootstrapping) return;
    if (scenarios.length === 0) {
      setBootstrapping(true);
      create({ name: 'Scratch', overrides: {} })
        .catch((err: unknown) => {
          // Surface but don't crash — user can retry via the tree controls in
          // future iterations. Keeping inline so the existing error UX stays.
          console.error('Failed to bootstrap baseline scenario', err);
        })
        .finally(() => setBootstrapping(false));
    }
  }, [loading, bootstrapping, scenarios.length, create]);

  // Auto-select the most-recently-created leaf so the detail pane has content
  // as soon as the bootstrap POST resolves (or the user logs in to an existing
  // tree). Picks the latest fork if any, otherwise falls back to the baseline.
  useEffect(() => {
    if (activeId !== null) return;
    if (scenarios.length === 0) return;
    const latestFork = [...scenarios]
      .reverse()
      .find((s) => s.kind !== 'baseline');
    setActiveId((latestFork ?? scenarios[0]).id);
  }, [activeId, scenarios]);

  // Prune deleted scenarios from the compare set so the comparison view never
  // requests a stale id (the backend would 404 the whole compare).
  useEffect(() => {
    const liveIds = new Set(scenarios.map((s) => s.id));
    setCompareIds((prev) => {
      const filtered = prev.filter((id) => liveIds.has(id));
      return filtered.length === prev.length ? prev : filtered;
    });
  }, [scenarios]);

  const active = useScenarioDetail(activeId);
  // Walk the multi-year chain forward from whichever scenario is active. The
  // backend resolves to the chain root, so passing any chained scenario id
  // returns the same year-ordered list.
  const chain = useScenarioChain(activeId);

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
    // years means swapping both the year key (so useScenarios refetches the
    // right list) and the active scenario id (so the detail pane updates).
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

  return (
    <div>
      <header style={{ marginBottom: '0.75rem' }}>
        <h2>Personal T1 — {selectedYear}</h2>
        <p className="muted">
          Each scenario layers overrides on top of actuals. Edit overrides on the
          right to see recomputed totals; add scenarios to the compare bar to see
          them side-by-side.
        </p>
      </header>
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
          <p className="error" style={{ marginTop: '0.25rem' }}>
            Failed to load year chain: {chain.error}
          </p>
        )}
      </div>
      <div className="flex flex-col md:flex-row gap-6">
        <div className="md:w-64 md:flex-shrink-0">
          <ScenarioTree
            scenarios={scenarios}
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
            <ActiveScenarioPanel
              data={active.data}
              onOverridesChange={handleOverridesChange}
              onAssumptionsChange={handleAssumptionsChange}
              onAddToCompare={() => toggleCompare(active.data!.scenario.id)}
              inCompare={compareIds.includes(active.data.scenario.id)}
            />
          ) : null}
          {compareIds.length > 0 && (
            <CompareBar
              ids={compareIds}
              scenarios={scenarios}
              onRemove={toggleCompare}
              onClear={() => setCompareIds([])}
            />
          )}
          {compareIds.length > 1 && (
            <ComparisonView ids={compareIds} onClose={() => setCompareIds([])} />
          )}
        </div>
      </div>
    </div>
  );
}

interface ActiveScenarioPanelProps {
  data: ScenarioWithComputed;
  onOverridesChange: (next: Record<string, unknown>) => void;
  onAssumptionsChange: (next: { inflation?: number; investmentReturn?: number }) => void;
  onAddToCompare: () => void;
  inCompare: boolean;
}

function ActiveScenarioPanel({
  data,
  onOverridesChange,
  onAssumptionsChange,
  onAddToCompare,
  inCompare,
}: ActiveScenarioPanelProps) {
  const { scenario, computed } = data;
  // Backend serialises Decimal via toJSON → string, matching TaxLineDto. The
  // computed lines come back through `JSON.parse(JSON.stringify(...))` which
  // collapses the Decimal instances to their string form (see computeScenario).
  const lines = (computed.lines ?? []) as TaxLineDto[];
  const isProjection = scenario.kind === 'projection_root';
  return (
    <div>
      <header style={{ display: 'flex', alignItems: 'baseline', gap: '0.75rem' }}>
        <h3 style={{ margin: 0 }}>{scenario.name}</h3>
        <span className="muted">
          {scenario.kind === 'baseline' ? 'baseline (actuals)' : scenario.kind}
        </span>
        <button onClick={onAddToCompare} style={{ marginLeft: 'auto' }}>
          {inCompare ? '✓ In compare' : '+ Add to compare'}
        </button>
      </header>
      {isProjection && (
        <div style={{ marginBottom: '0.75rem' }}>
          <AssumptionsEditor
            assumptions={scenario.assumptions as { inflation?: number; investmentReturn?: number }}
            onChange={onAssumptionsChange}
          />
        </div>
      )}
      {isProjection && (
        <details className="mb-3 rounded-md border border-gray-200 bg-white">
          <summary className="cursor-pointer px-3 py-2 text-sm font-semibold text-gray-800">
            RRIF minimum withdrawal calculator
          </summary>
          <div className="px-3 pb-3">
            <RrifMinCalc />
          </div>
        </details>
      )}
      <OverrideEditor overrides={scenario.overrides} onChange={onOverridesChange} />
      <section style={{ marginTop: '1rem' }}>
        <h4>Computed totals</h4>
        <ul>
          {Object.entries(computed.totals).map(([k, v]) => (
            <li key={k}>
              <strong>{k}</strong>: {String(v)}
            </li>
          ))}
        </ul>
        <p className="muted">
          {computed.cached ? 'Cached snapshot' : 'Freshly computed'} at{' '}
          {new Date(computed.computedAt).toLocaleString()}
        </p>
      </section>
      {computed.warnings.length > 0 && (
        <section style={{ marginTop: '1rem' }}>
          <h4>Warnings</h4>
          <ul>
            {computed.warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </section>
      )}
      <section style={{ marginTop: '1rem' }}>
        <h4>Line breakdown</h4>
        <LineBreakdownTable lines={lines} />
      </section>
    </div>
  );
}

function LineBreakdownTable({ lines }: { lines: TaxLineDto[] }) {
  const [expanded, setExpanded] = useState<string | null>(null);
  if (lines.length === 0) return <p className="muted">No lines to display.</p>;
  return (
    <table>
      <thead>
        <tr>
          <th>Line</th>
          <th>Label</th>
          <th>Amount</th>
        </tr>
      </thead>
      <tbody>
        {lines.map((l) => (
          <LineRow
            key={l.code}
            line={l}
            expanded={expanded === l.code}
            onClick={() => setExpanded(expanded === l.code ? null : l.code)}
          />
        ))}
      </tbody>
    </table>
  );
}

function LineRow({
  line,
  expanded,
  onClick,
}: {
  line: TaxLineDto;
  expanded: boolean;
  onClick: () => void;
}) {
  return (
    <>
      <tr onClick={onClick} style={{ cursor: 'pointer' }}>
        <td>{line.code}</td>
        <td>{line.label}</td>
        <td>${line.amount}</td>
      </tr>
      {expanded && (
        <tr>
          <td colSpan={3}>
            {line.formula && <p className="muted">Formula: {line.formula}</p>}
            <ul>
              {line.inputs.map((i, idx) => (
                <li key={idx}>
                  {i.source}: ${i.amount}
                </li>
              ))}
            </ul>
          </td>
        </tr>
      )}
    </>
  );
}

interface CompareBarProps {
  ids: number[];
  scenarios: Scenario[];
  onRemove: (id: number) => void;
  onClear: () => void;
}

function CompareBar({ ids, scenarios, onRemove, onClear }: CompareBarProps) {
  const byId = new Map(scenarios.map((s) => [s.id, s]));
  return (
    <div
      style={{
        marginTop: '1rem',
        padding: '0.5rem',
        border: '1px solid rgba(255,255,255,0.12)',
        borderRadius: '4px',
      }}
    >
      <strong>Compare ({ids.length}):</strong>{' '}
      {ids.map((id) => (
        <button
          key={id}
          onClick={() => onRemove(id)}
          style={{ marginRight: '0.25rem' }}
        >
          {byId.get(id)?.name ?? `#${id}`} ×
        </button>
      ))}
      {ids.length > 0 && (
        <button onClick={onClear} style={{ marginLeft: '0.5rem' }}>
          Clear
        </button>
      )}
      {ids.length < 2 && (
        <span className="muted"> Add at least 2 to see the diff.</span>
      )}
    </div>
  );
}
