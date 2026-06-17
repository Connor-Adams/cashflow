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

import { Button } from '@/components/ui/button';

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
      className="flex flex-wrap items-center gap-2 border-b border pb-2"
    >
      {chain.length === 0 ? (
        <span className="text-sm text-muted-foreground">No years yet.</span>
      ) : (
        <ul className="flex flex-wrap items-center gap-1">
          {chain.map((entry) => {
            const { scenario } = entry;
            const isActive =
              scenario.year === activeYear &&
              (activeScenarioId === null || activeScenarioId === scenario.id);
            return (
              <li key={scenario.id}>
                <Button
                  type="button"
                  variant={isActive ? 'primary' : 'outline'}
                  size="sm"
                  onClick={() => onSelectYear(scenario.year, scenario.id)}
                  aria-current={isActive ? 'page' : undefined}
                  title={`${scenario.name}${scenario.kind === 'projection_root' ? ' (projection)' : ''}`}
                >
                  <span>{scenario.year}</span>
                  {scenario.kind === 'projection_root' && (
                    <span
                      aria-label="projected year"
                      className="ml-1 text-xs text-muted-foreground"
                    >
                      proj
                    </span>
                  )}
                </Button>
              </li>
            );
          })}
        </ul>
      )}

      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={onProjectNextYear}
        disabled={isProjecting || chain.length === 0}
        className="ml-auto border-dashed"
      >
        {isProjecting ? 'Projecting…' : '+ Project next year'}
      </Button>
    </nav>
  );
}
