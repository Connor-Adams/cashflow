import { useEffect, useState } from 'react';
import { useTaxEntities, type TaxEntity } from '../../hooks/useTaxEntities';
import {
  useCorpScenarios,
  type CorpScenario,
  type CorpScenarioWithComputed,
} from '../../hooks/useCorpScenarios';
import { useCorpScenarioDetail } from '../../hooks/useCorpScenarioDetail';
import { useCorpScenarioChain } from '../../hooks/useCorpScenarioChain';
import { type CorpTaxLineDto } from '../../hooks/useCorpReturn';
import { ScenarioTree } from './scenarios/ScenarioTree';
import { CorpOverrideEditor, type OtherCorpOption } from './scenarios/CorpOverrideEditor';
import { ComparisonView } from './scenarios/ComparisonView';
import { YearStripNav } from './scenarios/YearStripNav';
import { AssumptionsEditor } from './scenarios/AssumptionsEditor';
import type { Scenario } from '../../hooks/useScenarios';
import { patchJson } from '../../lib/api';

const CURRENT_YEAR = new Date().getFullYear().toString();

// Backend corp scenarios API takes an integer year. The tab's fiscal-year
// input accepts either a bare year ("2024") or a date-range string
// ("2024-01-01/2024-12-31"); we parse the first 4 chars as the start year for
// scenario API calls. The standalone fiscal-year input UI is preserved from
// the pre-scenario CorpT2Tab so existing muscle memory still works.
function parseYearInt(fiscalYear: string): number | null {
  const head = fiscalYear.trim().slice(0, 4);
  const n = Number(head);
  return Number.isInteger(n) && n >= 1900 && n <= 9999 ? n : null;
}

export function CorpT2Tab() {
  const [fiscalYear, setFiscalYear] = useState<string>(CURRENT_YEAR);
  const [inputValue, setInputValue] = useState<string>(CURRENT_YEAR);
  const { entities, error: entitiesError, reload: reloadEntities } = useTaxEntities();

  function handleApply() {
    const trimmed = inputValue.trim();
    if (trimmed) setFiscalYear(trimmed);
  }

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
  const yearInt = parseYearInt(fiscalYear);

  return (
    <div>
      <header style={{ marginBottom: '0.75rem' }}>
        <h2>Corp T2</h2>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem' }}>
          <label>
            Fiscal Year{' '}
            <input
              type="text"
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              placeholder="e.g. 2024 or 2024-01-01/2024-12-31"
              style={{ width: '18rem' }}
              onKeyDown={(e) => { if (e.key === 'Enter') handleApply(); }}
            />
          </label>
          <button onClick={handleApply}>Load</button>
        </div>
        <p className="muted">
          Each scenario layers overrides on top of actuals. Edit overrides on
          the right to see recomputed totals; add scenarios to the compare bar
          to see them side-by-side.
        </p>
      </header>
      {!corpEntity ? (
        <p className="muted">
          No corp entity for this household. Create one first (POST /api/tax/entities with kind=corp).
        </p>
      ) : yearInt === null ? (
        <p className="error">Fiscal year must start with a 4-digit year (e.g. 2024 or 2024-01-01/2024-12-31).</p>
      ) : (
        <>
          <AssociatedGroupInput corpEntity={corpEntity} onSaved={reloadEntities} />
          <CorpT2ScenarioWorkspace
            key={`${corpEntity.id}:${yearInt}`}
            entityId={corpEntity.id}
            year={yearInt}
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
    <div style={{ marginBottom: '0.75rem' }}>
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
          style={{ width: '16rem' }}
        />
      </label>
      {saving && <span className="muted" style={{ marginLeft: '0.5rem' }}>Saving…</span>}
      {error && <span className="error" style={{ marginLeft: '0.5rem' }}>Failed: {error}</span>}
      <p className="muted" style={{ margin: '0.25rem 0 0' }}>
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
  // CorpT2Tab's fiscalYear input. When the prop changes (user submits a new
  // fiscal year via the input) we re-seed local state to match.
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
  } = useCorpScenarios(entityId, selectedYear);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [compareIds, setCompareIds] = useState<number[]>([]);
  const [bootstrapping, setBootstrapping] = useState(false);
  const [isProjecting, setIsProjecting] = useState(false);

  // Auto-create a starter scenario on first load so the baseline materialises
  // and there is something for the user to edit immediately. The POST handler
  // auto-creates the baseline as parent + a fork named "Scratch" as the leaf.
  // Mirrors the P7 T13 PersonalT1Tab bootstrap pattern.
  useEffect(() => {
    if (loading || bootstrapping) return;
    if (scenarios.length === 0) {
      setBootstrapping(true);
      create({ name: 'Scratch', overrides: {} })
        .catch((err: unknown) => {
          console.error('Failed to bootstrap corp baseline scenario', err);
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
          <p className="error" style={{ marginTop: '0.25rem' }}>
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
            <CompareBar
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
              endpoint="/api/tax/scenarios/compare"
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
      <CorpOverrideEditor
        overrides={scenario.overrides}
        onChange={onOverridesChange}
        otherCorps={otherCorps}
      />
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
        <CorpLineBreakdownTable lines={lines} />
      </section>
    </div>
  );
}

function CorpLineBreakdownTable({ lines }: { lines: CorpTaxLineDto[] }) {
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
          <CorpLineRow
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

function CorpLineRow({
  line,
  expanded,
  onClick,
}: {
  line: CorpTaxLineDto;
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
              {line.inputs.map((inp, idx) => (
                <li key={idx}>{inp.source}: ${inp.amount}</li>
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
  scenarios: CorpScenario[];
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
