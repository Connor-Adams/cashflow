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

/**
 * Spend-by-category that decomposes accepted-linked itemized transactions into
 * their per-item categories (via splitTxnByItems), falling back to the txn's
 * own finalCategory when it has no usable links. Same return shape as the
 * direct aggregator; grand total is invariant because splitTxnByItems
 * reconciles allocations to the transaction amount (it books rounding/
 * uncategorized drift back to finalCategory).
 */
export function aggregateSpendByCategoryDecomposed(
  rows: DecomposeRow[],
  tree: CategoryTree,
  ctx: ItemAllocationContext,
  currency: string,
): { amountById: Map<number, number>; countById: Map<number, number>; uncat: number; uncatCount: number } {
  const amountById = new Map<number, number>();
  const countById = new Map<number, number>();
  let uncat = 0;
  let uncatCount = 0;

  const bump = (id: number | null, amount: number, touched: Set<number | null>) => {
    if (id != null && tree.parentById.has(id)) {
      amountById.set(id, (amountById.get(id) ?? 0) + amount);
      touched.add(id);
    } else {
      uncat += amount;
      touched.add(null);
    }
  };

  for (const t of rows) {
    if (isNonSpend(t.txnType, t.accountType ?? null)) continue;
    const a = num(t.amount);
    if (a == null) continue;

    const links = ctx.linksByTxn.get(t.id);
    const touched = new Set<number | null>();

    if (links && links.length > 0) {
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
      for (const alloc of allocations) {
        bump(alloc.categoryId, Math.abs(alloc.amount), touched);
      }
    } else {
      bump(t.finalCategoryId, Math.abs(a), touched);
    }

    // One count per distinct category this transaction touched.
    for (const id of touched) {
      if (id == null) uncatCount += 1;
      else countById.set(id, (countById.get(id) ?? 0) + 1);
    }
  }

  return { amountById, countById, uncat, uncatCount };
}
