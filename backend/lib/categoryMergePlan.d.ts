/**
 * Types for `categoryMergePlan.js`. See that file for why the implementation is
 * plain CommonJS outside `src/`.
 */
export interface PlanCategory {
  id: number; householdId: number; parentId: number | null; name: string; nameKey: string;
}
export interface PlanBudget { id: number; categoryId: number | null }
export interface Merge { householdId: number; nameKey: string; winnerId: number; loserId: number }
export interface Reparent { childId: number; newParentId: number }
export interface BudgetAction {
  budgetId: number; action: 'repoint' | 'detach'; categoryId: number | null;
}
export interface MergePlan { merges: Merge[]; reparents: Reparent[]; budgetActions: BudgetAction[] }

export function planCategoryMerges(
  categories: PlanCategory[],
  refCounts: Record<number, number> | Map<number, number>,
  budgets: PlanBudget[],
): MergePlan;

export function subtreeNames(
  categories: PlanCategory[],
  rootId: number,
  nameOf?: (category: PlanCategory) => string,
): Set<string>;
