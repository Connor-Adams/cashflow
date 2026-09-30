/**
 * Pure budget spend math: turn raw transaction rows into per-bucket spend, net
 * refunds back out, and combine the result with a budget's target.
 *
 * Moved here out of `routes/budgets.ts` so the route layer, the shared spend
 * loader (`budgetSpend.ts`) and the breach cron all depend on one module in one
 * direction. `routes/budgets.ts` re-exports every name below, so existing
 * importers (and the colocated tests that import from `./budgets`) are
 * unaffected.
 */
import { Op, type WhereOptions } from 'sequelize';
import type { BudgetTargetScope } from '../models/BudgetTarget';
import { num } from '../util/numbers';
import { splitTxnByItems } from '../import/splitTxnByItems';
import type { ItemAllocationContext } from '../summary/loadItemAllocations';
import type { CategoryTree } from '../categories/rollup';
import type { PeriodBounds } from './budgetPeriods';

/**
 * A category's own name plus every descendant category name, used to roll a
 * per-category budget up its subtree. Pure over a CategoryTree so it's testable
 * without a DB.
 */
export function categoryAndDescendantNames(
  tree: CategoryTree,
  categoryId: number,
): string[] {
  const childrenByParent = new Map<number, number[]>();
  for (const [id, parentId] of tree.parentById) {
    if (parentId == null) continue;
    const list = childrenByParent.get(parentId) ?? [];
    list.push(id);
    childrenByParent.set(parentId, list);
  }
  const names: string[] = [];
  const seen = new Set<number>();
  const stack = [categoryId];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const name = tree.nameById.get(id);
    if (name != null) names.push(name);
    for (const child of childrenByParent.get(id) ?? []) stack.push(child);
  }
  return names;
}

export type SpendRow = {
  id: number;
  currency: string;
  finalCategory: string | null;
  finalCategoryId?: number | null;
  finalBusiness: boolean;
  finalSplitType: string;
  amount: unknown;
  businessAmount: string;
  /**
   * DATEONLY 'YYYY-MM-DD'. Only needed by the rollover path, which fetches one
   * widened window and partitions the rows into prior-periods vs the current
   * period locally rather than issuing a query per period.
   */
  date?: string;
};

export type SpendByCategory = Map<
  string,
  { currency: string; category: string | null; categoryId: number | null; spent: number }
>;

/**
 * Aggregate raw transaction rows into spend per (currency, category).
 *
 * Spend semantics: charges land in the DB as NEGATIVE numbers, so we sum the
 * negation (`-amount`) and only count `amount < 0`. Positive amounts (refunds,
 * credits, payments, transfers) are intentionally ignored here — they offset
 * spend elsewhere but a budget tracks gross outflow against a target. The
 * dashboard's category report already nets credits separately if desired.
 *
 * Pure helper exported so the route's correctness can be tested without a DB.
 */
export function aggregateSpendByCategory(
  rows: SpendRow[],
  itemContext?: ItemAllocationContext,
): SpendByCategory {
  const out: SpendByCategory = new Map();
  for (const row of rows) {
    const amount = num(row.amount);
    if (amount == null || amount >= 0) continue;
    const allocations = itemContext
      ? splitTxnByItems({
          txn: {
            id: row.id,
            amount: String(row.amount),
            currency: row.currency,
            finalCategory: row.finalCategory,
            finalCategoryId: row.finalCategoryId ?? null,
            finalBusiness: row.finalBusiness,
            finalSplitType: row.finalSplitType,
            businessAmount: row.businessAmount,
          },
          links: itemContext.linksByTxn.get(row.id) ?? [],
          ordersById: itemContext.ordersById,
          itemsByOrder: itemContext.itemsByOrder,
        })
      : [
          {
            category: row.finalCategory,
            categoryId: row.finalCategoryId ?? null,
            amount,
            businessAmount: 0,
            currency: row.currency,
          },
        ];
    for (const alloc of allocations) {
      if (alloc.amount >= 0) continue;
      const spend = -alloc.amount;
      const key = `${alloc.currency}\0${alloc.category ?? ''}`;
      const existing = out.get(key) ?? {
        currency: alloc.currency,
        category: alloc.category,
        categoryId: alloc.categoryId ?? null,
        spent: 0,
      };
      existing.spent += spend;
      out.set(key, existing);
    }
  }
  return out;
}

/** One refund's net-back: a positive amount keyed by the ORIGINAL purchase's
 *  (currency, category) so it offsets the bucket the purchase landed in. */
export type RefundNet = {
  amount: unknown;
  currency: string;
  category: string | null;
};

/**
 * Net refunds out of an aggregated spend map IN PLACE, subtracting only the
 * refunded amount from the matching (currency, category) bucket — never the
 * whole original purchase. A $100 charge with a $30 partial refund leaves $70
 * of spend; a full $100 refund leaves $0. The old `excludeRefundedPurchases`
 * path dropped the entire original purchase row, which understated spend for
 * partial refunds.
 *
 * Each refund is keyed by the ORIGINAL purchase's category/currency (resolved
 * via `linkedTransactionId`), so the offset hits the same bucket the purchase
 * contributed to. Buckets are clamped at 0 so an over-refund can't push spend
 * negative. Refunds with no matching bucket are ignored.
 *
 * Pure helper exported so the route + cron share one definition and it can be
 * unit-tested without a DB.
 */
export function netRefundsFromSpend(
  spendByCategory: Map<
    string,
    { currency: string; category: string | null; spent: number }
  >,
  refunds: RefundNet[],
): void {
  for (const refund of refunds) {
    const refundAmount = num(refund.amount);
    if (refundAmount == null || refundAmount <= 0) continue;
    const key = `${refund.currency}\0${refund.category ?? ''}`;
    const bucket = spendByCategory.get(key);
    if (!bucket) continue;
    bucket.spent = Math.max(0, bucket.spent - refundAmount);
  }
}

/**
 * Map raw refund rows (each with the original purchase id + refund amount)
 * to `RefundNet`s keyed by the ORIGINAL purchase's (currency, category),
 * resolved from the in-window transaction rows. Refunds whose original
 * purchase isn't in the window (so it was never counted) are dropped — there
 * is nothing to net. Pure + exported so route and cron share it.
 */
export function resolveRefundNets(
  rows: Array<Pick<SpendRow, 'id' | 'currency' | 'finalCategory'>>,
  refundRows: Array<{ linkedTransactionId: number; amount: unknown }>,
): RefundNet[] {
  const byId = new Map<number, { currency: string; category: string | null }>();
  for (const row of rows) {
    byId.set(row.id, { currency: row.currency, category: row.finalCategory });
  }
  const nets: RefundNet[] = [];
  for (const refund of refundRows) {
    const original = byId.get(refund.linkedTransactionId);
    if (!original) continue;
    nets.push({
      amount: refund.amount,
      currency: original.currency,
      category: original.category,
    });
  }
  return nets;
}

export type BudgetForProgress = {
  id: number;
  category: string | null;
  currency: string;
  amount: string;
  /**
   * The category's own name plus every descendant category name. When present
   * on a per-category budget, spend rolls up the subtree (a budget on a parent
   * counts its children). Omitted → the budget matches only its own bucket.
   */
  categoryNames?: string[] | null;
  /**
   * Signed remainder accumulated over this budget's completed prior periods:
   * positive is unspent surplus carried forward, negative is an overspend
   * carried forward as a reduction. Only non-zero when `rolloverEnabled` is
   * set. UNCLAMPED by design, so `amount + carriedIn` may reach zero or go
   * negative — see `percentUsed` below. Omitted/0 reproduces the pre-rollover
   * numbers exactly.
   */
  carriedIn?: number;
};

export type ProgressItem = {
  budgetId: number;
  category: string | null;
  currency: string;
  /**
   * What the budget actually allows this period: `baseTarget + carriedIn`. This
   * is the number the UI and the breach notification body quote, because it is
   * the amount the user can really spend. Equals `baseTarget` when there is no
   * carry.
   */
  target: number;
  /** The configured `amount`, before any carry. */
  baseTarget: number;
  /** See {@link BudgetForProgress.carriedIn}. 0 when rollover is off. */
  carriedIn: number;
  spent: number;
  remaining: number;
  percentUsed: number;
  periodStart: string;
  periodEnd: string;
};

/**
 * Combine budget rows with the spend aggregate. Pure so we can unit-test the
 * "overall" vs per-category split without a DB.
 *
 * Overall semantics: a budget with `category == null` sums spend across every
 * category that shares its currency. Per-category budgets look up just their
 * own (currency, category) key.
 *
 * `percentUsed` is measured against the carry-adjusted effective target, so a
 * funded envelope does not read as overspent and one carrying debt does. Because
 * the carry is unclamped, the effective target can reach zero or go negative —
 * at which point `spent / effectiveTarget` is meaningless, so the defined
 * behavior is `100 + (spent / baseTarget) * 100`: a full 100% for being
 * underwater before the period started, plus whatever fraction of one base
 * allowance gets spent on top. That keeps the value monotone in `spent` for
 * every sign of the target (it is discontinuous at the boundary, which is
 * unavoidable for any finite rule). `baseTarget` is always > 0 — `amount` is
 * validated positive on write — so the denominator is safe.
 */
export function computeBudgetProgress(
  budgets: BudgetForProgress[],
  spendByCategory: Map<
    string,
    { currency: string; category: string | null; spent: number }
  >,
  bounds: PeriodBounds
): ProgressItem[] {
  const totalsByCurrency = new Map<string, number>();
  for (const value of spendByCategory.values()) {
    totalsByCurrency.set(
      value.currency,
      (totalsByCurrency.get(value.currency) ?? 0) + value.spent
    );
  }
  return budgets.map((budget) => {
    const baseTarget = Number(budget.amount);
    const carriedIn = budget.carriedIn ?? 0;
    const effectiveTarget = baseTarget + carriedIn;
    let spent: number;
    if (budget.category == null) {
      spent = totalsByCurrency.get(budget.currency) ?? 0;
    } else if (budget.categoryNames && budget.categoryNames.length > 0) {
      // Roll the subtree up: sum this category's bucket plus every descendant's.
      const seen = new Set<string>();
      spent = 0;
      for (const name of budget.categoryNames) {
        if (seen.has(name)) continue;
        seen.add(name);
        spent += spendByCategory.get(`${budget.currency}\0${name}`)?.spent ?? 0;
      }
    } else {
      const key = `${budget.currency}\0${budget.category}`;
      spent = spendByCategory.get(key)?.spent ?? 0;
    }
    const remaining = effectiveTarget - spent;
    const percentUsed =
      effectiveTarget > 0
        ? (spent / effectiveTarget) * 100
        : baseTarget > 0
          ? 100 + (spent / baseTarget) * 100
          : 0;
    return {
      budgetId: budget.id,
      category: budget.category,
      currency: budget.currency,
      target: effectiveTarget,
      baseTarget,
      carriedIn,
      spent,
      remaining,
      percentUsed,
      periodStart: bounds.periodStart,
      periodEnd: bounds.periodEnd,
    };
  });
}

/**
 * Maps a BudgetTargetScope into a Sequelize where-clause that filters
 * Transactions to the subset that counts toward the budget. The mapping
 * is intentionally a single source of truth so chat tools and other
 * consumers can adopt the same vocabulary later.
 *
 *   household → visibility = 'shared' (the joint/shared spend)
 *   personal  → visibility = 'private' AND (final_business=false OR null)
 *   partner   → ownership_type = 'partner'
 *   business  → final_business = true
 *
 * Returns `{}` for unknown scope to fail-open (don't accidentally hide all
 * transactions due to a bad string).
 */
export function scopeWhereClause(scope: BudgetTargetScope): WhereOptions {
  switch (scope) {
    case 'personal':
      return {
        visibility: 'private',
        [Op.or]: [{ finalBusiness: false }, { finalBusiness: null }],
      } as WhereOptions;
    case 'partner':
      return { ownershipType: 'partner' } as WhereOptions;
    case 'business':
      return { finalBusiness: true } as WhereOptions;
    case 'household':
      return { visibility: 'shared' } as WhereOptions;
    default:
      return {} as WhereOptions;
  }
}
