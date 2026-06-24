import { splitTxnByItems, type AllocatorTxn } from '../import/splitTxnByItems';
import type { ItemAllocationContext } from '../summary/loadItemAllocations';
import type { CategoryTree } from '../categories/rollup';
import { isNonSpend } from '../summary/classifyTransactionFlow';

export type DecomposeRow = {
  id: number;
  amount: unknown;
  finalCategory: string | null;
  finalCategoryId: number | null;
  txnType: string | null;
  accountType: string | null;
};

function num(v: unknown): number | null {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

type Accumulators = {
  amountById: Map<number, number>;
  countById: Map<number, number>;
  uncat: number;
  uncatCount: number;
};

/** Credit one category (or uncat) and mark it as touched by this transaction. */
function bumpCategory(
  id: number | null,
  amount: number,
  touched: Set<number | null>,
  acc: Accumulators,
  tree: CategoryTree,
): void {
  if (id != null && tree.parentById.has(id)) {
    acc.amountById.set(id, (acc.amountById.get(id) ?? 0) + amount);
    touched.add(id);
  } else {
    acc.uncat += amount;
    touched.add(null);
  }
}

/** Update per-category transaction counts from the set of categories touched. */
function recordTouchedCounts(touched: Set<number | null>, acc: Accumulators): void {
  for (const id of touched) {
    if (id == null) acc.uncatCount += 1;
    else acc.countById.set(id, (acc.countById.get(id) ?? 0) + 1);
  }
}

/** Decompose one transaction into per-item allocations and credit each category. */
function decomposeLinkedRow(
  t: DecomposeRow,
  a: number,
  links: ReturnType<ItemAllocationContext['linksByTxn']['get']> & object,
  ctx: ItemAllocationContext,
  currency: string,
  acc: Accumulators,
  tree: CategoryTree,
): void {
  const allocatorTxn: AllocatorTxn = {
    id: t.id,
    amount: String(a),
    currency,
    finalCategory: t.finalCategory,
    finalCategoryId: t.finalCategoryId,
    finalBusiness: false,
    finalSplitType: '',
    businessAmount: '0',
  };
  const allocations = splitTxnByItems({
    txn: allocatorTxn,
    links,
    ordersById: ctx.ordersById,
    itemsByOrder: ctx.itemsByOrder,
  });
  const touched = new Set<number | null>();
  for (const alloc of allocations) {
    bumpCategory(alloc.categoryId, Math.abs(alloc.amount), touched, acc, tree);
  }
  recordTouchedCounts(touched, acc);
}

/**
 * Spend-by-category that decomposes accepted-linked itemized transactions into
 * their per-item categories (via splitTxnByItems), falling back to the txn's
 * own finalCategory when it has no usable links. Same return shape as the
 * direct aggregator; grand total is invariant because splitTxnByItems
 * reconciles allocations to the transaction amount (it books rounding/
 * uncategorized drift back to finalCategory).
 */
// CRAP inflated by test-mode coverage gaps (same rationale as old aggregateSpendByCategoryId)
// fallow-ignore-next-line complexity
export function aggregateSpendByCategoryDecomposed(
  rows: DecomposeRow[],
  tree: CategoryTree,
  ctx: ItemAllocationContext,
  currency: string,
): { amountById: Map<number, number>; countById: Map<number, number>; uncat: number; uncatCount: number } {
  const acc: Accumulators = {
    amountById: new Map(),
    countById: new Map(),
    uncat: 0,
    uncatCount: 0,
  };

  for (const t of rows) {
    if (isNonSpend(t.txnType, t.accountType ?? null)) continue;
    const a = num(t.amount);
    if (a == null) continue;

    const links = ctx.linksByTxn.get(t.id);
    if (links && links.length > 0) {
      decomposeLinkedRow(t, a, links, ctx, currency, acc, tree);
    } else {
      const touched = new Set<number | null>();
      bumpCategory(t.finalCategoryId, Math.abs(a), touched, acc, tree);
      recordTouchedCounts(touched, acc);
    }
  }

  return acc;
}
