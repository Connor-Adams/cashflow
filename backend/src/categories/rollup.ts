// backend/src/categories/rollup.ts
import type { Transaction } from 'sequelize';
// Import the model class directly, NOT the '../models' barrel — the barrel
// re-exports models whose hooks dynamic-import categories/* modules, which the
// fallow audit flags as an import cycle (this bit B1; see Global Constraints).
import { Category } from '../models/Category';

export type CategoryTree = {
  parentById: Map<number, number | null>;
  nameById: Map<number, string>;
  depthById: Map<number, number>;
  pathById: Map<number, string>;
};

export type RollupRow = {
  categoryId: number;
  name: string;
  path: string;
  parentId: number | null;
  depth: number;
  directTotal: number;
  rolledTotal: number;
};

export async function loadCategoryTree(
  householdId: number,
  opts: { transaction?: Transaction } = {},
): Promise<CategoryTree> {
  const rows = await Category.findAll({
    where: { householdId },
    attributes: ['id', 'parentId', 'name'],
    transaction: opts.transaction,
  });
  const parentById = new Map<number, number | null>();
  const nameById = new Map<number, string>();
  for (const r of rows) {
    parentById.set(r.id, r.parentId);
    nameById.set(r.id, r.name);
  }
  const depthById = new Map<number, number>();
  const pathById = new Map<number, string>();
  const resolve = (id: number, visiting: Set<number> = new Set()): { depth: number; path: string } => {
    const cached = pathById.get(id);
    if (cached != null) return { depth: depthById.get(id)!, path: cached };
    // Cycle guard: if we're already visiting this id, treat it as a root (depth 0)
    if (visiting.has(id)) {
      const name = nameById.get(id) ?? '';
      depthById.set(id, 0);
      pathById.set(id, name);
      return { depth: 0, path: name };
    }
    const parent = parentById.get(id) ?? null;
    const name = nameById.get(id) ?? '';
    if (parent == null || !parentById.has(parent)) {
      depthById.set(id, 0);
      pathById.set(id, name);
      return { depth: 0, path: name };
    }
    visiting.add(id);
    const up = resolve(parent, visiting);
    visiting.delete(id);
    const depth = up.depth + 1;
    const path = `${up.path} / ${name}`;
    depthById.set(id, depth);
    pathById.set(id, path);
    return { depth, path };
  };
  for (const id of parentById.keys()) resolve(id);
  return { parentById, nameById, depthById, pathById };
}

export function rollupByCategoryId(
  rawByCategoryId: Map<number, number>,
  tree: CategoryTree,
): Map<number, number> {
  const rolled = new Map<number, number>();
  for (const [categoryId, amount] of rawByCategoryId) {
    if (!tree.parentById.has(categoryId)) continue; // unknown/stale id — skip
    let current: number | null = categoryId;
    const visited = new Set<number>();
    while (current != null && tree.parentById.has(current)) {
      // Cycle guard: if we've already visited this id in this chain, break
      if (visited.has(current)) break;
      visited.add(current);
      rolled.set(current, (rolled.get(current) ?? 0) + amount);
      current = tree.parentById.get(current) ?? null;
    }
  }
  return rolled;
}

export function buildRollupRows(
  rawByCategoryId: Map<number, number>,
  tree: CategoryTree,
): RollupRow[] {
  const rolled = rollupByCategoryId(rawByCategoryId, tree);
  const ids = new Set<number>([...rolled.keys()]);
  const rows: RollupRow[] = [];
  for (const id of ids) {
    rows.push({
      categoryId: id,
      name: tree.nameById.get(id) ?? '',
      path: tree.pathById.get(id) ?? '',
      parentId: tree.parentById.get(id) ?? null,
      depth: tree.depthById.get(id) ?? 0,
      directTotal: rawByCategoryId.get(id) ?? 0,
      rolledTotal: rolled.get(id) ?? 0,
    });
  }
  rows.sort((a, b) => a.path.localeCompare(b.path));
  return rows;
}
