import { Op } from 'sequelize';
import {
  ExternalOrder,
  ExternalOrderItem,
  TransactionOrderLink,
} from '../models';
import type {
  AllocatorLink,
  AllocatorOrder,
  AllocatorItem,
} from '../import/splitTxnByItems';

export type ItemAllocationContext = {
  linksByTxn: Map<number, AllocatorLink[]>;
  ordersById: Map<number, AllocatorOrder>;
  itemsByOrder: Map<number, AllocatorItem[]>;
};

export async function loadItemAllocationContext(
  txnIds: number[],
): Promise<ItemAllocationContext> {
  const empty: ItemAllocationContext = {
    linksByTxn: new Map(),
    ordersById: new Map(),
    itemsByOrder: new Map(),
  };
  if (txnIds.length === 0) return empty;

  // Only accepted links may drive allocations. The matcher mass-creates
  // 'suggested' rows and supersession leaves 'rejected' ones behind; feeding
  // either into splitTxnByItems double-counts the txn across categories and
  // fabricates offsetting drift rows. Mirrors every other money-math consumer
  // (recomputeTransactionReviewFromItems, itemizedSummaries).
  const links = await TransactionOrderLink.findAll({
    where: { transactionId: { [Op.in]: txnIds }, status: 'accepted' },
  });
  if (links.length === 0) return empty;

  const orderIds = Array.from(new Set(links.map((l) => l.externalOrderId)));
  const [orders, items] = await Promise.all([
    ExternalOrder.findAll({ where: { id: { [Op.in]: orderIds } } }),
    ExternalOrderItem.findAll({ where: { externalOrderId: { [Op.in]: orderIds } } }),
  ]);

  const linksByTxn = new Map<number, AllocatorLink[]>();
  for (const l of links) {
    const list = linksByTxn.get(l.transactionId) ?? [];
    list.push({ externalOrderId: l.externalOrderId, linkedAmount: l.linkedAmount });
    linksByTxn.set(l.transactionId, list);
  }

  const ordersById = new Map<number, AllocatorOrder>();
  for (const o of orders) {
    ordersById.set(o.id, {
      id: o.id,
      subtotal: o.subtotal,
      tax: o.tax,
      shipping: o.shipping,
      total: o.total,
      currency: o.currency,
    });
  }

  const itemsByOrder = new Map<number, AllocatorItem[]>();
  for (const it of items) {
    const list = itemsByOrder.get(it.externalOrderId) ?? [];
    list.push({
      id: it.id,
      totalPrice: it.totalPrice,
      unitPrice: it.unitPrice,
      quantity: it.quantity,
      inferredCategory: it.inferredCategory,
      categoryOverride: it.categoryOverride,
      businessUsePercent: it.businessUsePercent,
      businessUseOverride: it.businessUseOverride,
    });
    itemsByOrder.set(it.externalOrderId, list);
  }

  return { linksByTxn, ordersById, itemsByOrder };
}
