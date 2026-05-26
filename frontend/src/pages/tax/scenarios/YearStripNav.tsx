// frontend/src/pages/tax/scenarios/YearStripNav.tsx
//
// Year strip nav (P9 Task 7). Renders a horizontal strip of year buttons —
// one per year in the multi-year scenario chain — followed by a "+ Project
// next year" action. The active year is highlighted; clicking another year
// calls `onSelectYear(year, scenarioId)` so the parent can swap the active
// scenario id without losing the rest of its UI state.
//
// Pure presentational: all data (chain, active year, isProjecting flag) flows
// in via props; all mutations bubble out via callbacks (`onSelectYear`,
// `onProjectNextYear`). The parent owns the POST /:id/project-next-year
// mutation and the reload-on-success choreography.
//
// `chain` is expected to be in year order (the backend returns it that way
// from `GET /:id/chain`); we don't re-sort defensively. If the same year
// appears twice (shouldn't happen), the last entry wins because React keys
// on `scenario.id`, not year.
//
// `entityId` is currently unused in the rendered output but is part of the
// documented prop shape (Task 7) so consumers can pass it without an
// awkward refactor when we add per-entity context (e.g. a label, an aria
// region name, or analytics tagging) in a follow-up.

interface ChainEntryShape {
  scenario: { id: number; year: number; kind: string; name: string };
  computed?: unknown;
}

interface Props {
  entityId: number;
  activeYear: number;
  activeScenarioId: number | null;
  chain: ChainEntryShape[];
  onSelectYear: (year: number, scenarioId: number) => void;
  onProjectNextYear: () => void;
  isProjecting: boolean;
}

export function YearStripNav({
  entityId,
  activeYear,
  activeScenarioId,
  chain,
  onSelectYear,
  onProjectNextYear,
  isProjecting,
}: Props) {
  // entityId is currently consumed via the aria label so screen readers can
  // disambiguate when multiple year strips render on the same page (e.g.
  // personal + corp side-by-side).
  void entityId;

  return (
    <nav
      aria-label={`Year strip for entity ${entityId}`}
      className="flex flex-wrap items-center gap-2 border-b border-gray-200 pb-2"
    >
      {chain.length === 0 ? (
        <span className="text-sm text-gray-500">No years yet.</span>
      ) : (
        <ul className="flex flex-wrap items-center gap-1">
          {chain.map((entry) => {
            const { scenario } = entry;
            const isActive =
              scenario.year === activeYear &&
              (activeScenarioId === null || activeScenarioId === scenario.id);
            return (
              <li key={scenario.id}>
                <button
                  type="button"
                  onClick={() => onSelectYear(scenario.year, scenario.id)}
                  aria-current={isActive ? 'page' : undefined}
                  className={
                    isActive
                      ? 'rounded-md border border-blue-500 bg-blue-50 px-3 py-1 text-sm font-semibold text-blue-700'
                      : 'rounded-md border border-gray-200 bg-white px-3 py-1 text-sm text-gray-700 hover:border-gray-300 hover:bg-gray-50'
                  }
                  title={`${scenario.name}${scenario.kind === 'projection_root' ? ' (projection)' : ''}`}
                >
                  <span>{scenario.year}</span>
                  {scenario.kind === 'projection_root' && (
                    <span
                      aria-label="projected year"
                      className="ml-1 text-xs text-gray-500"
                    >
                      proj
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      )}

      <button
        type="button"
        onClick={onProjectNextYear}
        disabled={isProjecting || chain.length === 0}
        className="ml-auto rounded-md border border-dashed border-gray-300 px-3 py-1 text-sm text-gray-600 hover:border-gray-400 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {isProjecting ? 'Projecting…' : '+ Project next year'}
      </button>
    </nav>
  );
}
