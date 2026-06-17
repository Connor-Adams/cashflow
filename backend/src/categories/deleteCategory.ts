import { Category } from '../models';
import { CategoryError } from './errors';

export async function deleteCategory(householdId: number, id: number): Promise<void> {
  const node = await Category.findOne({ where: { id, householdId } });
  if (!node) throw new CategoryError('not_found', `category ${id} not found`);

  const childCount = await Category.count({ where: { householdId, parentId: id } });
  if (childCount > 0) {
    throw new CategoryError(
      'has_children',
      'reparent or remove child categories before deleting this one',
    );
  }

  await node.destroy();
}
