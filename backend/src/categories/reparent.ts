import { Op } from 'sequelize';
import { Category } from '../models';
import { wouldCreateCycle } from './cycle';
import { CategoryError } from './errors';

export async function reparentCategory(
  householdId: number,
  id: number,
  newParentId: number | null,
): Promise<Category> {
  const node = await Category.findOne({ where: { id, householdId } });
  if (!node) throw new CategoryError('not_found', `category ${id} not found`);

  if (newParentId != null) {
    const parent = await Category.findOne({ where: { id: newParentId, householdId } });
    if (!parent) throw new CategoryError('parent_not_found', `parent ${newParentId} not found`);
    if (await wouldCreateCycle(householdId, id, newParentId)) {
      throw new CategoryError('cycle', 'cannot move a category into its own subtree');
    }
  }

  const conflict = await Category.findOne({
    where: {
      householdId,
      parentId: newParentId,
      nameKey: node.nameKey,
      id: { [Op.ne]: id },
    },
  });
  if (conflict) {
    throw new CategoryError(
      'sibling_conflict',
      `a sibling named "${node.name}" already exists under the target parent`,
    );
  }

  node.set('parentId', newParentId);
  await node.save();
  return node;
}
