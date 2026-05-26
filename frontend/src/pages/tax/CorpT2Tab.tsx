import { useEffect, useState } from 'react';
import { useTaxEntities } from '../../hooks/useTaxEntities';
import {
  useCorpScenarios,
  type CorpScenario,
  type CorpScenarioWithComputed,
} from '../../hooks/useCorpScenarios';
import { useCorpScenarioDetail } from '../../hooks/useCorpScenarioDetail';
import { type CorpTaxLineDto } from '../../hooks/useCorpReturn';
import { ScenarioTree } from './scenarios/ScenarioTree';
import { CorpOverrideEditor } from './scenarios/CorpOverrideEditor';
import { ComparisonView } from './scenarios/ComparisonView';
import type { Scenario } from '../../hooks/useScenarios';

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
  const { entities, error: entitiesError } = useTaxEntities();

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
        <CorpT2ScenarioWorkspace
          key={`${corpEntity.id}:${yearInt}`}
          entityId={corpEntity.id}
          year={yearInt}
        />
      )}
    </div>
  );
}

interface WorkspaceProps {
  entityId: number;
  year: number;
}

function CorpT2ScenarioWorkspace({ entityId, year }: WorkspaceProps) {
  const { scenarios, loading, error, create, patch, fork, remove } = useCorpScenarios(entityId, year);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [compareIds, setCompareIds] = useState<number[]>([]);
  const [bootstrapping, setBootstrapping] = useState(false);

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
            onOverridesChange={handleOverridesChange}
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
            endpoint="/api/tax/corp-scenarios/compare"
          />
        )}
      </div>
    </div>
  );
}

interface ActiveCorpScenarioPanelProps {
  data: CorpScenarioWithComputed;
  onOverridesChange: (next: Record<string, unknown>) => void;
  onAddToCompare: () => void;
  inCompare: boolean;
}

function ActiveCorpScenarioPanel({
  data,
  onOverridesChange,
  onAddToCompare,
  inCompare,
}: ActiveCorpScenarioPanelProps) {
  const { scenario, computed } = data;
  // Backend serialises Decimal via toJSON → string, matching CorpTaxLineDto.
  // The computed lines come back through JSON.parse(JSON.stringify(...))
  // which collapses Decimal instances to their string form (see
  // computeCorpScenario).
  const lines = (computed.lines ?? []) as CorpTaxLineDto[];
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
      <CorpOverrideEditor overrides={scenario.overrides} onChange={onOverridesChange} />
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
