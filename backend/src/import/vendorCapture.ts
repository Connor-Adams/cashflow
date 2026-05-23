import crypto from 'crypto';
import { sequelize, ExternalOrder, ExternalOrderItem } from '../models';

export interface CapturedItemInput {
  title: string;
  quantity?: number;
  unitPrice?: number | null;
  totalPrice?: number | null;
}

export interface CapturedOrderInput {
  vendorOrderId: string | null;
  orderDate: string;
  total: number;
  currency: string;
  paymentLast4: string | null;
  items: CapturedItemInput[];
}

export interface CaptureOrdersArgs {
  householdId: number;
  userId: number;
  vendor: string;
  source: string;
  orders: CapturedOrderInput[];
}

export interface CaptureOrderOutcome {
  vendorOrderId: string | null;
  externalOrderId: number;
  status: 'created' | 'updated' | 'skipped';
}

export interface CaptureResult {
  created: number;
  updated: number;
  skipped: number;
  orders: CaptureOrderOutcome[];
}

function stableHash(parts: Array<string | number | null>): string {
  return crypto
    .createHash('sha256')
    .update(parts.map((p) => (p == null ? '' : String(p))).join('|'))
    .digest('hex')
    .slice(0, 32);
}

function buildDedupeKey(vendor: string, order: CapturedOrderInput): string {
  if (order.vendorOrderId) return `${vendor}:${order.vendorOrderId}`;
  return `${vendor}:${stableHash([
    order.orderDate,
    order.total,
    order.paymentLast4,
    order.items[0]?.title ?? '',
  ])}`;
}

function itemsAreEquivalent(
  existing: { title: string }[],
  next: CapturedItemInput[],
): boolean {
  if (existing.length !== next.length) return false;
  const sortKey = (t: string) => t.trim().toLowerCase();
  const a = existing.map((it) => sortKey(it.title)).sort();
  const b = next.map((it) => sortKey(it.title)).sort();
  return a.every((t, i) => t === b[i]);
}

export async function captureOrders(args: CaptureOrdersArgs): Promise<CaptureResult> {
  if (!args.vendor || !args.vendor.trim()) {
    throw new Error('vendor is required');
  }
  if (!args.source) {
    throw new Error('source is required');
  }
  if (!Array.isArray(args.orders)) {
    throw new Error('orders must be an array');
  }

  const vendor = args.vendor.toLowerCase();
  let created = 0;
  let updated = 0;
  let skipped = 0;
  const outcomes: CaptureOrderOutcome[] = [];

  for (const order of args.orders) {
    const dedupeKey = buildDedupeKey(vendor, order);
    await sequelize.transaction(async (t) => {
      const existing = await ExternalOrder.findOne({
        where: { householdId: args.householdId, dedupeKey },
        transaction: t,
      });
      if (!existing) {
        const row = await ExternalOrder.create(
          {
            householdId: args.householdId,
            createdByUserId: args.userId,
            vendor,
            vendorOrderId: order.vendorOrderId,
            dedupeKey,
            orderDate: order.orderDate,
            shipmentDate: null,
            subtotal: null,
            tax: null,
            shipping: null,
            total: String(order.total),
            currency: order.currency || 'CAD',
            paymentLast4: order.paymentLast4,
            source: args.source,
            rawPayload: { items: order.items },
          },
          { transaction: t },
        );
        if (order.items.length > 0) {
          await ExternalOrderItem.bulkCreate(
            order.items.map((it) => ({
              externalOrderId: row.id,
              title: it.title,
              quantity: it.quantity ?? 1,
              unitPrice: it.unitPrice != null ? String(it.unitPrice) : null,
              totalPrice: it.totalPrice != null ? String(it.totalPrice) : null,
              inferredCategory: null,
              businessUsePercent: null,
              confidence: null,
              rawPayload: null,
            })),
            { transaction: t },
          );
        }
        created++;
        outcomes.push({ vendorOrderId: order.vendorOrderId, externalOrderId: row.id, status: 'created' });
        return;
      }

      const existingItems = await ExternalOrderItem.findAll({
        where: { externalOrderId: existing.id },
        transaction: t,
      });

      if (
        Number(existing.total) === Number(order.total) &&
        existing.orderDate === order.orderDate &&
        existing.paymentLast4 === order.paymentLast4 &&
        itemsAreEquivalent(existingItems, order.items)
      ) {
        skipped++;
        outcomes.push({ vendorOrderId: order.vendorOrderId, externalOrderId: existing.id, status: 'skipped' });
        return;
      }

      await existing.update(
        {
          total: String(order.total),
          orderDate: order.orderDate,
          paymentLast4: order.paymentLast4,
          currency: order.currency || existing.currency,
          source: args.source,
          rawPayload: { items: order.items },
        },
        { transaction: t },
      );

      if (order.items.length >= existingItems.length) {
        await ExternalOrderItem.destroy({ where: { externalOrderId: existing.id }, transaction: t });
        if (order.items.length > 0) {
          await ExternalOrderItem.bulkCreate(
            order.items.map((it) => ({
              externalOrderId: existing.id,
              title: it.title,
              quantity: it.quantity ?? 1,
              unitPrice: it.unitPrice != null ? String(it.unitPrice) : null,
              totalPrice: it.totalPrice != null ? String(it.totalPrice) : null,
              inferredCategory: null,
              businessUsePercent: null,
              confidence: null,
              rawPayload: null,
            })),
            { transaction: t },
          );
        }
      }

      updated++;
      outcomes.push({ vendorOrderId: order.vendorOrderId, externalOrderId: existing.id, status: 'updated' });
    });
  }

  return { created, updated, skipped, orders: outcomes };
}
