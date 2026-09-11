import { Op } from 'sequelize';
import {
  Account,
  ExternalOrder,
  ExternalOrderItem,
  Transaction,
  TransactionOrderLink,
} from '../models';
import type {
  AllocatorLink,
  AllocatorOrder,
  AllocatorItem,
} from '../import/splitTxnByItems';
import {
  buildLast4Map,
  classifyCardOwnershipForVendor,
  resolveAccountLast4,
} from '../amazon/cardOwnership';

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
  //
  // Two guards scope this to the case it was actually designed for (task 13):
  //   1. Only vendor 'amazon' may ever be classified 'foreign'. Every other
  //      vendor is always included regardless of payment_last4 — production
  //      has zero accepted Amazon links but 7 accepted non-Amazon links (6
  //      costco, 1 uber_eats), and this exclusion was never meant for them.
  //   2. Even for Amazon, an order is not excluded when the LINKED
  //      TRANSACTION's account has no derivable last4 (resolveAccountLast4
  //      returns null — e.g. Costco's opaque short_code 'costco' or
  //      Wealthsimple's 'HQ6LMLTK8CAD'). Without a last4 on the account side
  //      there is no basis for the comparison, so the order must be kept.
  //      This is per-LINK, not per-order: the same order could in principle
  //      link to transactions on different accounts.
  const householdIds = Array.from(new Set(orders.map((o) => o.householdId))).filter(
    (id): id is number => id != null,
  );

  let last4Map: Map<string, number[]>;
  const derivableLast4ByAccountId = new Map<number, string>();
  if (householdIds.length > 0) {
    const accounts = await Account.findAll({
      where: { householdId: { [Op.in]: householdIds } },
      attributes: ['id', 'shortCode'],
    });
    last4Map = buildLast4Map(accounts.map((a) => ({ id: a.id, shortCode: a.shortCode })));
    for (const a of accounts) {
      const last4 = resolveAccountLast4(a.shortCode);
      if (last4 != null) derivableLast4ByAccountId.set(a.id, last4);
    }
  } else {
    // No household context: skip the query entirely and use an empty map.
    last4Map = new Map();
  }

  // Guard 2 needs each link's transaction -> account mapping. Loaded once
  // (hot path — no per-row queries), keyed by the txn ids the caller passed in.
  const accountIdByTxnId = new Map<number, number>();
  if (householdIds.length > 0) {
    const transactions = await Transaction.findAll({
      where: { id: { [Op.in]: txnIds } },
      attributes: ['id', 'accountId'],
    });
    for (const t of transactions) {
      accountIdByTxnId.set(t.id, t.accountId);
    }
  }

  const ordersByIdRaw = new Map(orders.map((o) => [o.id, o]));

  function isForeignLink(link: TransactionOrderLink): boolean {
    // No household context at all: we have no basis to call anything
    // foreign, regardless of vendor or account.
    if (householdIds.length === 0) return false;
    const order = ordersByIdRaw.get(link.externalOrderId);
    if (!order) return false;
    // Guard 2: the linked transaction's account must have a derivable last4
    // to have any basis for comparison.
    const accountId = accountIdByTxnId.get(link.transactionId);
    const linkedAccountLast4 =
      accountId != null ? derivableLast4ByAccountId.get(accountId) : undefined;
    if (linkedAccountLast4 == null) return false;
    // Guard 1 (only Amazon orders may ever be classified foreign) is folded
    // into classifyCardOwnershipForVendor -- reused here rather than
    // reimplemented, so the vendor rule cannot drift between this exclusion
    // chokepoint and the DTO serializers (backend/src/amazon/cardOwnership.ts,
    // backend/src/routes/items.ts, backend/src/routes/receipts.ts).
    return classifyCardOwnershipForVendor(order.vendor, order.paymentLast4, last4Map) === 'foreign';
  }

  const linksByTxn = new Map<number, AllocatorLink[]>();
  const keptOrderIds = new Set<number>();
  for (const l of links) {
    if (isForeignLink(l)) continue;
    keptOrderIds.add(l.externalOrderId);
    const list = linksByTxn.get(l.transactionId) ?? [];
    list.push({ externalOrderId: l.externalOrderId, linkedAmount: l.linkedAmount });
    linksByTxn.set(l.transactionId, list);
  }

  const ordersById = new Map<number, AllocatorOrder>();
  for (const o of orders) {
    if (!keptOrderIds.has(o.id)) continue;
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
    if (!keptOrderIds.has(it.externalOrderId)) continue;
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
