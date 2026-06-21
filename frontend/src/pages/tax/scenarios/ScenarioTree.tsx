import { useMemo } from 'react';
import { Button } from '@connor-adams/designsystem'
import type { Scenario } from '../../../hooks/useScenarios';

interface Props {
  scenarios: Scenario[];
  activeId: number | null;
  onSelect: (id: number) => void;
  onForkActive: () => void;
  onDeleteActive: () => void;
}

interface TreeNode { scenario: Scenario; children: TreeNode[] }

function buildTree(scenarios: Scenario[]): TreeNode[] {
  const byParent = new Map<number | null, Scenario[]>();
  for (const s of scenarios) {
    const key = s.parentId;
    const arr = byParent.get(key) ?? [];
    arr.push(s);
    byParent.set(key, arr);
  }
  function makeNode(s: Scenario): TreeNode {
    return { scenario: s, children: (byParent.get(s.id) ?? []).map(makeNode) };
  }
  return (byParent.get(null) ?? []).map(makeNode);
}

export function ScenarioTree({ scenarios, activeId, onSelect, onForkActive, onDeleteActive }: Props) {
  const tree = useMemo(() => buildTree(scenarios), [scenarios]);
  return (
    <aside className="min-w-60">
      <h3>Scenarios</h3>
      {tree.length === 0 ? (
        <p className="muted">No scenarios yet.</p>
      ) : (
        <TreeList nodes={tree} activeId={activeId} onSelect={onSelect} />
      )}
      <div className="mt-3 flex gap-2">
        <Button variant="secondary" size="sm" onClick={onForkActive} disabled={activeId === null}>+ Fork from current</Button>
        <Button variant="destructive" size="sm" onClick={onDeleteActive} disabled={activeId === null}>Delete</Button>
      </div>
    </aside>
  );
}

function TreeList({ nodes, activeId, onSelect }: {
  nodes: TreeNode[];
  activeId: number | null;
  onSelect: (id: number) => void;
}) {
  return (
    <ul className="list-none m-0 space-y-1 pl-4">
      {nodes.map((n) => (
        <li key={n.scenario.id}>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onSelect(n.scenario.id)}
            className={[
              'cursor-pointer px-2 py-1 text-left text-inherit w-full rounded justify-start',
              n.scenario.id === activeId ? 'bg-muted' : 'bg-transparent',
            ].join(' ')}
          >
            {n.scenario.kind === 'baseline' ? '• ' : '├ '}
            {n.scenario.name}
            {n.scenario.kind === 'baseline' && <span className="muted"> (actuals)</span>}
          </Button>
          {n.children.length > 0 && <TreeList nodes={n.children} activeId={activeId} onSelect={onSelect} />}
        </li>
      ))}
    </ul>
  );
}
