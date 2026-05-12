import { ExternalOrder, ExternalOrderItem, sequelize } from '../models';
import { parseAmazonReportCsv } from './parseAmazonReportCsv';
import type { NormalizedAmazonOrder } from './normalizeAmazonOrder';

export type AmazonImportSummary = {
  created: number;
  skipped: number;
  failed: number;
  importedItems: number;
  failedRows: Array<{ rowIndex: number; message: string }>;
};

async function persistOrder(
  order: NormalizedAmazonOrder,
  householdId: number,
  userId: number,
): Promise<'created' | 'skipped'> {
  const existing = await ExternalOrder.findOne({
    where: { householdId, dedupeKey: order.dedupeKey },
  });
  if (existing) return 'skipped';

  await sequelize.transaction(async (transaction) => {
    const row = await ExternalOrder.create(
      {
        householdId,
        createdByUserId: userId,
        vendor: 'amazon',
        vendorOrderId: order.vendorOrderId,
        dedupeKey: order.dedupeKey,
        orderDate: order.orderDate,
        shipmentDate: order.shipmentDate,
        subtotal: order.subtotal == null ? null : String(order.subtotal),
        tax: order.tax == null ? null : String(order.tax),
        shipping: order.shipping == null ? null : String(order.shipping),
        total: order.total == null ? null : String(order.total),
        currency: order.currency,
        paymentLast4: order.paymentLast4,
        source: order.source,
        rawPayload: order.rawPayload,
      },
      { transaction },
    );
    for (const item of order.items) {
      await ExternalOrderItem.create(
        {
          externalOrderId: row.id,
          title: item.title,
          quantity: Math.max(1, Number(item.quantity) || 1),
          unitPrice: item.unitPrice == null ? null : String(item.unitPrice),
          totalPrice: item.totalPrice == null ? null : String(item.totalPrice),
          inferredCategory: item.inferredCategory,
          businessUsePercent:
            item.businessUsePercent == null ? null : String(item.businessUsePercent),
          confidence: item.confidence == null ? null : String(item.confidence),
          rawPayload: item.rawPayload,
        },
        { transaction },
      );
    }
  });
  return 'created';
}

export async function importAmazonReportCsv(args: {
  text: string;
  householdId: number;
  userId: number;
}): Promise<AmazonImportSummary> {
  const parsed = parseAmazonReportCsv(args.text);
  const summary: AmazonImportSummary = {
    created: 0,
    skipped: 0,
    failed: parsed.failedRows.length,
    importedItems: 0,
    failedRows: parsed.failedRows,
  };
  for (const order of parsed.orders) {
    try {
      const result = await persistOrder(order, args.householdId, args.userId);
      if (result === 'created') {
        summary.created += 1;
        summary.importedItems += order.items.length;
      } else {
        summary.skipped += 1;
      }
    } catch (e) {
      summary.failed += 1;
      summary.failedRows.push({
        rowIndex: 0,
        message: e instanceof Error ? e.message : 'Failed to persist order',
      });
    }
  }
  return summary;
}
