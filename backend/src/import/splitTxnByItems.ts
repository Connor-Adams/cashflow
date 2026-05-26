import { logger } from '../observability/logger';

export type AllocatorTxn = {
  id: number;
  amount: string;
  currency: string;
  finalCategory: string | null;
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
  categoryOverride: string | null;
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

function effectiveBusinessPct(item: AllocatorItem): number {
  const ov = item.businessUseOverride;
  if (ov != null) return n(ov);
  return n(item.businessUsePercent);
}

export function splitTxnByItems(input: AllocatorInput): CategoryAllocation[] {
  const { txn, links, ordersById, itemsByOrder } = input;
  const txnAmount = n(txn.amount);
  const sign = txnAmount < 0 ? -1 : 1;
  const txnAbs = Math.abs(txnAmount);

  const usable = links.filter((l) => {
    const order = ordersById.get(l.externalOrderId);
    const items = itemsByOrder.get(l.externalOrderId);
    return order != null && items != null && items.length > 0;
  });
  if (usable.length === 0) {
    const bizAmt = n(txn.businessAmount);
    return [
      {
        category: txn.finalCategory,
        amount: txnAmount,
        businessAmount: bizAmt === 0 ? 0 : bizAmt * sign,
        currency: txn.currency,
      },
    ];
  }

  const bucket = new Map<string, CategoryAllocation>();
  const add = (cat: string | null, amount: number, businessAmount: number) => {
    const key = cat ?? '';
    const existing = bucket.get(key);
    if (existing) {
      existing.amount += amount;
      existing.businessAmount += businessAmount;
    } else {
      bucket.set(key, {
        category: cat,
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
        const biz = (effectiveBusinessPct(it) / 100) * portion;
        add(cat, portion * sign, biz * sign);
        allocated += portion;
      }
      continue;
    }

    for (const it of items) {
      const rawBase = itemBase(it);
      const weight = baseSum > 0 ? rawBase / baseSum : 0;
      const portion = rawBase * share + extras * weight;
      const cat = effectiveCategory(it, txn.finalCategory);
      const biz = (effectiveBusinessPct(it) / 100) * portion;
      add(cat, portion * sign, biz * sign);
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
    add(txn.finalCategory, drift * sign, 0);
  }

  return Array.from(bucket.values());
}
