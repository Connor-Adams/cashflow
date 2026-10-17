import { Category } from '../models';
import { normalizeCategoryName } from './normalizeName';
import { CategoryError } from './errors';

export async function createCategory(
  householdId: number,
  name: string,
  parentId: number | null,
): Promise<Category> {
  if (parentId != null) {
    const parent = await Category.findOne({ where: { id: parentId, householdId } });
    if (!parent) throw new CategoryError('parent_not_found', `parent ${parentId} not found`);
  }

  const nameKey = normalizeCategoryName(name.trim());
  // Category names are unique per HOUSEHOLD, not per parent
  // (categories_household_name_key_unique): budgets and spend rollups join on
  // the name string, so two same-named nodes anywhere are indistinguishable
  // downstream.
  const conflict = await Category.findOne({ where: { householdId, nameKey } });
  if (conflict) {
    throw new CategoryError(
      'name_conflict',
      `a category named "${name.trim()}" already exists in this household`,
    );
  }

  return Category.create({ householdId, name: name.trim(), parentId, icon: null });
}
