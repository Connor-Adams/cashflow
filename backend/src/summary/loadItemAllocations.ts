import { Op } from 'sequelize';
import {
  Account,
  ExternalOrder,
  ExternalOrderItem,
  TransactionOrderLink,
} from '../models';
import type {
  AllocatorLink,
  AllocatorOrder,
  AllocatorItem,
} from '../import/splitTxnByItems';
import { buildLast4Map, classifyCardOwnership } from '../amazon/cardOwnership';

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

  // Orders paid with a card Cashflow does not track are not the household's
  // spend — 291 of 538 Amazon orders in production carry a last4 belonging to
  // no account. They stay visible and matchable elsewhere, but never reach a
  // total. `unknown` (no last4 at all, 135 orders) is deliberately NOT
  // excluded: absence of a last4 is not evidence of a foreign card. Accounts
  // are loaded once, scoped to the households the orders belong to, so this
  // chokepoint (nine consumers, hot dashboard/budget path) never issues a
  // per-order query. When no households are resolvable (all orders have
  // householdId === null), the query is skipped entirely and we do not filter
  // by foreign status — with no household context, we have no basis to call
  // anything foreign.
  const householdIds = Array.from(new Set(orders.map((o) => o.householdId))).filter(
    (id): id is number => id != null,
  );

  let last4Map: Map<string, number[]>;
  if (householdIds.length > 0) {
    const accounts = await Account.findAll({
      where: { householdId: { [Op.in]: householdIds } },
      attributes: ['id', 'shortCode'],
    });
    last4Map = buildLast4Map(accounts.map((a) => ({ id: a.id, shortCode: a.shortCode })));
  } else {
    // No household context: skip the query entirely and use an empty map.
    last4Map = new Map();
  }

  // Only filter by foreign status if we had household context to determine it.
  // When householdIds is empty (all orders have null householdId), we cannot
  // determine ownership, so we include all orders: both 'unknown' (no last4)
  // and what would be 'foreign' (last4 not in empty map).
  const ownedOrders =
    householdIds.length > 0
      ? orders.filter((o) => classifyCardOwnership(o.paymentLast4, last4Map) !== 'foreign')
      : orders;
  const ownedOrderIds = new Set(ownedOrders.map((o) => o.id));

  const linksByTxn = new Map<number, AllocatorLink[]>();
  for (const l of links) {
    if (!ownedOrderIds.has(l.externalOrderId)) continue;
    const list = linksByTxn.get(l.transactionId) ?? [];
    list.push({ externalOrderId: l.externalOrderId, linkedAmount: l.linkedAmount });
    linksByTxn.set(l.transactionId, list);
  }

  const ordersById = new Map<number, AllocatorOrder>();
  for (const o of ownedOrders) {
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
    if (!ownedOrderIds.has(it.externalOrderId)) continue;
    const list = itemsByOrder.get(it.externalOrderId) ?? [];
    list.push({
      id: it.id,
      totalPrice: it.totalPrice,
      unitPrice: it.unitPrice,
      quantity: it.quantity,
      inferredCategory: it.inferredCategory,
      inferredCategoryId: it.inferredCategoryId,
      categoryOverride: it.categoryOverride,
      categoryOverrideId: it.categoryOverrideId,
      businessUsePercent: it.businessUsePercent,
      businessUseOverride: it.businessUseOverride,
    });
    itemsByOrder.set(it.externalOrderId, list);
  }

  return { linksByTxn, ordersById, itemsByOrder };
}
