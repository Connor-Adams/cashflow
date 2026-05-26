import { useMemo } from 'react';
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
    <aside style={{ minWidth: 240 }}>
      <h3>Scenarios</h3>
      {tree.length === 0 ? (
        <p className="muted">No scenarios yet.</p>
      ) : (
        <TreeList nodes={tree} activeId={activeId} onSelect={onSelect} />
      )}
      <div style={{ marginTop: '0.75rem', display: 'flex', gap: '0.5rem' }}>
        <button onClick={onForkActive} disabled={activeId === null}>+ Fork from current</button>
        <button onClick={onDeleteActive} disabled={activeId === null}>Delete</button>
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
    <ul style={{ listStyle: 'none', paddingLeft: '1rem' }}>
      {nodes.map((n) => (
        <li key={n.scenario.id}>
          <button
            onClick={() => onSelect(n.scenario.id)}
            style={{
              background: n.scenario.id === activeId ? 'rgba(255,255,255,0.08)' : 'transparent',
              border: 'none', color: 'inherit', cursor: 'pointer', padding: '0.25rem 0.5rem', textAlign: 'left',
            }}
          >
            {n.scenario.kind === 'baseline' ? '• ' : '├ '}
            {n.scenario.name}
            {n.scenario.kind === 'baseline' && <span className="muted"> (actuals)</span>}
          </button>
          {n.children.length > 0 && <TreeList nodes={n.children} activeId={activeId} onSelect={onSelect} />}
        </li>
      ))}
    </ul>
  );
}
