import type { Transaction } from 'sequelize';
// Import the model class directly (not the '../models' barrel): the barrel
// re-exports Transaction/Rule/BudgetTarget/ExternalOrderItem, which dynamic-import
// this module in their beforeSave hooks — importing the barrel here creates an
// import cycle that the fallow audit flags. Category.ts only pulls normalizeName.
import { Category } from '../models/Category';
import { normalizeCategoryName } from './normalizeName';

/**
 * Resolve a category NAME to a root Category node id for a household,
 * find-or-creating a flat root node (parentId null). Mirrors the legacy
 * ensureCategory create-a-root behavior, returning the id so write paths can
 * set their *CategoryId FK. Null / empty / whitespace name → null.
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
  const [node] = await Category.findOrCreate({
    where: { householdId, parentId: null, nameKey },
    defaults: { householdId, parentId: null, name: trimmed, icon: null },
    transaction: opts.transaction,
  });
  return node.id;
}
