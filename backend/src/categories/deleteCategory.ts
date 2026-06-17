import { Op } from 'sequelize';
import { Category, Transaction, ExternalOrderItem, Rule, BudgetTarget } from '../models';
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

  const [txnRefs, itemRefs, ruleRefs, budgetRefs] = await Promise.all([
    Transaction.count({
      where: {
        householdId,
        [Op.or]: [{ autoCategoryId: id }, { categoryOverrideId: id }, { finalCategoryId: id }],
      },
    }),
    ExternalOrderItem.count({ where: { [Op.or]: [{ inferredCategoryId: id }, { categoryOverrideId: id }] } }),
    Rule.count({ where: { householdId, categoryId: id } }),
    BudgetTarget.count({ where: { householdId, categoryId: id } }),
  ]);
  if (txnRefs + itemRefs + ruleRefs + budgetRefs > 0) {
    throw new CategoryError(
      'has_references',
      'reassign transactions, items, rules, and budgets off this category before deleting it',
    );
  }

  await node.destroy();
}
