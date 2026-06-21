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
  const conflict = await Category.findOne({ where: { householdId, parentId, nameKey } });
  if (conflict) {
    throw new CategoryError(
      'sibling_conflict',
      `a sibling named "${name.trim()}" already exists under the target parent`,
    );
  }

  return Category.create({ householdId, name: name.trim(), parentId, icon: null });
}
