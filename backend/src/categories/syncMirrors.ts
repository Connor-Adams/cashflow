import type { Transaction as SequelizeTransaction } from 'sequelize';
import { Transaction, ExternalOrderItem, Rule, BudgetTarget } from '../models';

/**
 * Fan a renamed category's new leaf name out to every denormalized string
 * mirror that references the node id. Call inside the rename transaction.
 *
 * Uses `Model.update(...)` (static) — does NOT fire the `beforeSave` instance
 * hooks, so there is no id re-resolution: only the string mirror is set.
 */
export async function syncCategoryLeafNameMirrors(
  categoryId: number,
  newLeafName: string,
  transaction: SequelizeTransaction,
): Promise<void> {
  await Promise.all([
    Transaction.update(
      { autoCategory: newLeafName },
      { where: { autoCategoryId: categoryId }, transaction },
    ),
    Transaction.update(
      { categoryOverride: newLeafName },
      { where: { categoryOverrideId: categoryId }, transaction },
    ),
    Transaction.update(
      { finalCategory: newLeafName },
      { where: { finalCategoryId: categoryId }, transaction },
    ),
    ExternalOrderItem.update(
      { inferredCategory: newLeafName },
      { where: { inferredCategoryId: categoryId }, transaction },
    ),
    ExternalOrderItem.update(
      { categoryOverride: newLeafName },
      { where: { categoryOverrideId: categoryId }, transaction },
    ),
    Rule.update(
      { category: newLeafName },
      { where: { categoryId }, transaction },
    ),
    BudgetTarget.update(
      { category: newLeafName },
      { where: { categoryId }, transaction },
    ),
  ]);
}
