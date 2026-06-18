// frontend/src/components/CategoryRollupTree.tsx
import { useMemo, useState } from 'react';
import { Tree, TreeGroup, TreeRow } from '@/components/ui/tree';
import type { RollupRow } from '../types/api';

type Props = { rows: RollupRow[]; currency: string };

function format(n: number): string {
  return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

export function CategoryRollupTree({ rows, currency }: Props) {
  const { roots, childrenByParent } = useMemo(() => {
    const scoped = rows.filter((r) => r.currency === currency);
    const childrenByParent = new Map<number, RollupRow[]>();
    const byId = new Map<number, RollupRow>();
    for (const r of scoped) byId.set(r.categoryId, r);
    const roots: RollupRow[] = [];
    for (const r of scoped) {
      if (r.parentId != null && byId.has(r.parentId)) {
        const list = childrenByParent.get(r.parentId) ?? [];
        list.push(r);
        childrenByParent.set(r.parentId, list);
      } else {
        roots.push(r);
      }
    }
    const cmp = (a: RollupRow, b: RollupRow) => b.rolledTotal - a.rolledTotal;
    roots.sort(cmp);
    for (const list of childrenByParent.values()) list.sort(cmp);
    return { roots, childrenByParent };
  }, [rows, currency]);

  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  if (roots.length === 0) return <p className="muted">No category spend</p>;

  const renderRow = (r: RollupRow) => {
    const kids = childrenByParent.get(r.categoryId) ?? [];
    const isOpen = expanded.has(r.categoryId);
    return (
      <li key={r.categoryId}>
        <TreeRow
          expandable={kids.length > 0}
          expanded={isOpen}
          toggleLabel={r.name}
          onToggle={() => setExpanded((prev) => {
            const next = new Set(prev);
            if (next.has(r.categoryId)) next.delete(r.categoryId);
            else next.add(r.categoryId);
            return next;
          })}
          trailing={<span className="tabular-nums text-sm">{format(r.rolledTotal)}</span>}
        >
          <span className="truncate text-sm">{r.name}</span>
        </TreeRow>
        {isOpen && kids.length > 0 && <TreeGroup>{kids.map(renderRow)}</TreeGroup>}
      </li>
    );
  };

  return <Tree>{roots.map(renderRow)}</Tree>;
}
