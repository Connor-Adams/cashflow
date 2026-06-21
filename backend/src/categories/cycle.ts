import { Category } from '../models';

/**
 * True if moving `nodeId` under `newParentId` would create a loop —
 * i.e. newParentId is nodeId itself, or sits within nodeId's subtree.
 * Walks upward from newParentId to a root; if it meets nodeId, it's a cycle.
 */
export async function wouldCreateCycle(
  householdId: number,
  nodeId: number,
  newParentId: number,
): Promise<boolean> {
  let cursor: number | null = newParentId;
  while (cursor != null) {
    if (cursor === nodeId) return true;
    const parent: Category | null = await Category.findOne({
      where: { id: cursor, householdId },
      attributes: ['id', 'parentId'],
    });
    cursor = parent ? parent.parentId : null;
  }
  return false;
}
