import { logger } from '../observability/logger';

export type AllocatorTxn = {
  id: number;
  amount: string;
  currency: string;
  finalCategory: string | null;
  finalCategoryId?: number | null;
  finalBusiness: boolean;
  finalSplitType: string;
  businessAmount: string;
};

export type AllocatorLink = {
  externalOrderId: number;
  linkedAmount: string | null;
};

export type AllocatorOrder = {
  id: number;
  subtotal: string | null;
  tax: string | null;
  shipping: string | null;
  total: string | null;
  currency: string;
};

export type AllocatorItem = {
  id: number;
  totalPrice: string | null;
  unitPrice: string | null;
  quantity: number;
  inferredCategory: string | null;
  inferredCategoryId?: number | null;
  categoryOverride: string | null;
  categoryOverrideId?: number | null;
  businessUsePercent: string | null;
  businessUseOverride: string | null;
};

export type AllocatorInput = {
  txn: AllocatorTxn;
  links: AllocatorLink[];
  ordersById: Map<number, AllocatorOrder>;
  itemsByOrder: Map<number, AllocatorItem[]>;
};

export type CategoryAllocation = {
  category: string | null;
  categoryId: number | null;
  amount: number;
  businessAmount: number;
  currency: string;
};

function n(v: string | null): number {
  if (v == null || v === '') return 0;
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
}

function itemBase(item: AllocatorItem): number {
  if (item.totalPrice != null) return n(item.totalPrice);
  if (item.unitPrice != null) return n(item.unitPrice) * (item.quantity || 1);
  return 0;
}

function effectiveCategory(item: AllocatorItem, txnCategory: string | null): string | null {
  return item.categoryOverride ?? item.inferredCategory ?? txnCategory;
}

function effectiveCategoryId(item: AllocatorItem, txnCategoryId: number | null): number | null {
  return item.categoryOverrideId ?? item.inferredCategoryId ?? txnCategoryId;
}

/**
 * Business fraction (0..1) for an item. Explicit per-item percentages win;
 * otherwise fall back to the txn-level business fraction so itemizing a
 * business txn doesn't silently re-book its spend as personal (imported
 * Amazon/receipt items usually carry no business pct at all).
 */
function effectiveBusinessFraction(item: AllocatorItem, fallback: number): number {
  if (item.businessUseOverride != null) return n(item.businessUseOverride) / 100;
  if (item.businessUsePercent != null) return n(item.businessUsePercent) / 100;
  return fallback;
}

export function splitTxnByItems(input: AllocatorInput): CategoryAllocation[] {
  const { txn, links, ordersById, itemsByOrder } = input;
  const txnAmount = n(txn.amount);
  const sign = txnAmount < 0 ? -1 : 1;
  const txnAbs = Math.abs(txnAmount);

  const usable = links.filter((l) => {
    const order = ordersById.get(l.externalOrderId);
    const items = itemsByOrder.get(l.externalOrderId);
    if (order == null || items == null || items.length === 0) return false;
    // Cross-currency order/item prices are not txn-currency amounts; allocating
    // them as-is skews category totals by the FX factor (and dumps the
    // difference into a phantom drift row). Matching only penalizes currency
    // mismatch and manual links never check it, so guard here.
    return (
      !order.currency ||
      !txn.currency ||
      order.currency.toUpperCase() === txn.currency.toUpperCase()
    );
  });
  if (usable.length === 0) {
    const bizAmt = n(txn.businessAmount);
    return [
      {
        category: txn.finalCategory,
        categoryId: txn.finalCategoryId ?? null,
        amount: txnAmount,
        businessAmount: bizAmt,
        currency: txn.currency,
      },
    ];
  }

  // Fraction of the txn that is business spend (0..1). businessAmount carries
  // the txn's sign, so the ratio is positive; clamp for safety.
  const txnBizRatio = txnAmount !== 0 ? n(txn.businessAmount) / txnAmount : 0;
  const txnBizFraction = Number.isFinite(txnBizRatio)
    ? Math.min(Math.max(txnBizRatio, 0), 1)
    : 0;

  const txnCategoryId = txn.finalCategoryId ?? null;
  const bucket = new Map<string, CategoryAllocation>();
  const add = (cat: string | null, catId: number | null, amount: number, businessAmount: number) => {
    const key = cat ?? '';
    const existing = bucket.get(key);
    if (existing) {
      existing.amount += amount;
      existing.businessAmount += businessAmount;
    } else {
      bucket.set(key, {
        category: cat,
        categoryId: catId,
        amount,
        businessAmount,
        currency: txn.currency,
      });
    }
  };

  let allocated = 0;
  for (const link of usable) {
    const order = ordersById.get(link.externalOrderId)!;
    const items = itemsByOrder.get(link.externalOrderId)!;
    const orderTotal = n(order.total);
    const linkAmt = link.linkedAmount != null ? n(link.linkedAmount) : orderTotal;
    const share = orderTotal > 0 ? linkAmt / orderTotal : 1;

    const baseSum = items.reduce((s, it) => s + itemBase(it), 0);
    const extras = (n(order.tax) + n(order.shipping)) * share;

    if (baseSum <= 0) {
      const portion = linkAmt / items.length;
      for (const it of items) {
        const cat = effectiveCategory(it, txn.finalCategory);
        const catId = effectiveCategoryId(it, txnCategoryId);
        const biz = effectiveBusinessFraction(it, txnBizFraction) * portion;
        add(cat, catId, portion * sign, biz * sign);
        allocated += portion;
      }
      continue;
    }

    for (const it of items) {
      const rawBase = itemBase(it);
      const weight = baseSum > 0 ? rawBase / baseSum : 0;
      const portion = rawBase * share + extras * weight;
      const cat = effectiveCategory(it, txn.finalCategory);
      const catId = effectiveCategoryId(it, txnCategoryId);
      const biz = effectiveBusinessFraction(it, txnBizFraction) * portion;
      add(cat, catId, portion * sign, biz * sign);
      allocated += portion;
    }
  }

  const drift = txnAbs - allocated;
  if (Math.abs(drift) >= 0.005) {
    logger.info({
      txnId: txn.id,
      expected: txnAbs,
      computed: allocated,
      drift,
    }, 'split_txn_drift');
    add(txn.finalCategory, txnCategoryId, drift * sign, drift * sign * txnBizFraction);
  }

  return Array.from(bucket.values());
}
