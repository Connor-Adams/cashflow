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
  // All updates share `transaction` (one pg connection), so they must run
  // sequentially. Promise.all would pipeline queries on the same client
  // ("already executing a query", a hard error in pg@9).
  await Transaction.update(
    { autoCategory: newLeafName },
    { where: { autoCategoryId: categoryId }, transaction },
  );
  await Transaction.update(
    { categoryOverride: newLeafName },
    { where: { categoryOverrideId: categoryId }, transaction },
  );
  await Transaction.update(
    { finalCategory: newLeafName },
    { where: { finalCategoryId: categoryId }, transaction },
  );
  await ExternalOrderItem.update(
    { inferredCategory: newLeafName },
    { where: { inferredCategoryId: categoryId }, transaction },
  );
  await ExternalOrderItem.update(
    { categoryOverride: newLeafName },
    { where: { categoryOverrideId: categoryId }, transaction },
  );
  await Rule.update(
    { category: newLeafName },
    { where: { categoryId }, transaction },
  );
  await BudgetTarget.update(
    { category: newLeafName },
    { where: { categoryId }, transaction },
  );
}
