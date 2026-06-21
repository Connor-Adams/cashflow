import type { Transaction } from 'sequelize';
// Import the model class directly (not the '../models' barrel): the barrel
// re-exports Transaction/Rule/BudgetTarget/ExternalOrderItem, which dynamic-import
// this module in their beforeSave hooks — importing the barrel here creates an
// import cycle that the fallow audit flags. Category.ts only pulls normalizeName.
import { Category } from '../models/Category';
import { normalizeCategoryName } from './normalizeName';

/**
 * Resolve a category NAME (a flat, pathless name from rules / import /
 * auto-categorization) to a Category node id for a household.
 *
 * Resolution order, so a name never silently forks an existing category into a
 * duplicate root:
 *   1. an existing ROOT (parentId null) with that name — the canonical target;
 *   2. else, if exactly ONE category anywhere in the tree bears that name, reuse
 *      it (e.g. a former root that has since been nested under a parent);
 *   3. else (none, or ambiguous: multiple same-named nested nodes and no root)
 *      find-or-create a flat root, the deterministic legacy behaviour.
 *
 * Null / empty / whitespace name → null.
 */
export async function resolveCategoryIdByName(
  householdId: number,
  name: string | null | undefined,
  opts: { transaction?: Transaction } = {},
): Promise<number | null> {
  if (name == null) return null;
  const trimmed = name.trim();
  if (!trimmed) return null;
  const nameKey = normalizeCategoryName(trimmed);

  const matches = await Category.findAll({
    where: { householdId, nameKey },
    attributes: ['id', 'parentId'],
    transaction: opts.transaction,
  });
  const root = matches.find((m) => m.parentId == null);
  if (root) return root.id;
  if (matches.length === 1) return matches[0].id; // single nested match — reuse, don't fork

  const [node] = await Category.findOrCreate({
    where: { householdId, parentId: null, nameKey },
    defaults: { householdId, parentId: null, name: trimmed, icon: null },
    transaction: opts.transaction,
  });
  return node.id;
}
