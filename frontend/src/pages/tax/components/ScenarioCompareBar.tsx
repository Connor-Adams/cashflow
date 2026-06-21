import { Button } from '@connor-adams/designsystem'

/**
 * Compare bar shared by the T1 and T2 scenario workspaces. It only needs each
 * scenario's id + name, so it accepts the minimal shape both `Scenario` and
 * `CorpScenario` satisfy rather than coupling to either return type.
 */
export interface ScenarioCompareBarProps {
  ids: number[];
  scenarios: { id: number; name: string }[];
  onRemove: (id: number) => void;
  onClear: () => void;
}

export function ScenarioCompareBar({ ids, scenarios, onRemove, onClear }: ScenarioCompareBarProps) {
  const byId = new Map(scenarios.map((s) => [s.id, s]));
  return (
    <div className="mt-4 rounded-md border border-border p-2">
      <strong>Compare ({ids.length}):</strong>{' '}
      {ids.map((id) => (
        <Button
          key={id}
          variant="ghost"
          size="sm"
          onClick={() => onRemove(id)}
          className="mr-1"
        >
          {byId.get(id)?.name ?? `#${id}`} ×
        </Button>
      ))}
      {ids.length > 0 && (
        <Button variant="ghost" size="sm" onClick={onClear} className="ml-2">
          Clear
        </Button>
      )}
      {ids.length < 2 && (
        <span className="muted"> Add at least 2 to see the diff.</span>
      )}
    </div>
  );
}
