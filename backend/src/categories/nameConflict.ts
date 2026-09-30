import { Op } from 'sequelize';
import { Category } from '../models';

/**
 * Household-wide duplicate-name lookup: category names are unique per
 * HOUSEHOLD, not per parent (categories_household_name_key_unique) — budgets
 * and spend rollups join on the name string, so two same-named nodes
 * anywhere in the household are indistinguishable downstream. See 773a37ee.
 *
 * Pass `excludeId` (the row's own id) when checking a rename/reparent so the
 * row doesn't conflict with itself.
 */
export async function findCategoryNameConflict(
  householdId: number,
  nameKey: string,
  excludeId?: number,
): Promise<Category | null> {
  return Category.findOne({
    where: {
      householdId,
      nameKey,
      ...(excludeId != null ? { id: { [Op.ne]: excludeId } } : {}),
    },
  });
}
