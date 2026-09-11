import { Op } from 'sequelize';
import { sequelize } from '../db';
import { ExternalOrder, ExternalOrderItem, TransactionOrderLink, Receipt, ExternalOrderTender } from '../models';
import { logger } from '../observability/logger';

/**
 * Fold Amazon orders that share a vendorOrderId into one row.
 *
 * The `amazon_report` CSV and the receipt email are two views of the same
 * order, and today they compete as separate ExternalOrders because the email
 * path (integrations/scanReceipts.ts) deliberately mixes the Gmail message id
 * into its dedupeKey so re-scans stay idempotent — which also means it never
 * collides with the CSV row's dedupeKey for the same vendorOrderId. Production
 * shows the CSV row carries a PER-SHIPMENT PARTIAL total while the email
 * carries the full order total that matches the card charge: of 75 shared
 * order ids, 16 have report_total < gmail_total, and in those cases the email
 * total equals the charge exactly. So the larger total wins.
 *
 * Orders with a null vendorOrderId are untouched — `amazonOrderDedupeKey`
 * already handles those.
 *
 * Design notes (deviating from a naive "destroy the losers" merge):
 *  - The OLDEST row (lowest id) survives. This is a stable, deterministic
 *    choice — every other field is unioned/coalesced onto it regardless of
 *    which source it came from, so survivorship doesn't privilege one source's
 *    data, only its identity (its id keeps working for anything already
 *    referencing it).
 *  - TransactionOrderLinks on a losing order are RE-POINTED at the survivor,
 *    not destroyed. A user may have already reviewed/accepted (or rejected) a
 *    match against whichever row got matched first — most likely the email
 *    row, since it usually carries the correct full total and therefore
 *    scores an exact-cent match. Destroying that link would silently discard
 *    the user's decision; runAmazonMatching's re-scoring pass afterward would
 *    likely reconstruct an equivalent 'suggested' link, but a manual
 *    'accepted' (or 'rejected') link is not rederivable that way. When both
 *    the survivor and a loser already have a link to the same transaction,
 *    the more authoritative one wins: accepted > rejected > suggested, then
 *    higher confidence.
 *  - Receipts and ExternalOrderTenders on a losing order are re-pointed too,
 *    for the same reason — a user may have manually attached a receipt image
 *    to whichever row existed at the time.
 *  - Items are unioned onto the survivor, skipping an item that is already
 *    present by (title, totalPrice, quantity) so a re-run (or an order that
 *    already got partially merged) doesn't duplicate them. Cross-source items
 *    rarely collide on this key in practice (the CSV and email format titles
 *    differently), so this is mostly a duplicate-import guard rather than a
 *    real cross-source de-dupe — unioning is the safe default when in doubt.
 *
 * Idempotent: once a vendorOrderId's losers are destroyed, later runs see a
 * single row for that id and skip it.
 */
export async function mergeDuplicateAmazonOrders(args: {
  householdId: number;
}): Promise<{ merged: number }> {
  const orders = await ExternalOrder.findAll({
    where: {
      householdId: args.householdId,
      vendor: 'amazon',
      vendorOrderId: { [Op.ne]: null },
    },
    order: [['id', 'ASC']],
  });

  const groups = new Map<string, ExternalOrder[]>();
  for (const o of orders) {
    const key = String(o.vendorOrderId);
    const list = groups.get(key) ?? [];
    list.push(o);
    groups.set(key, list);
  }

  let merged = 0;
  for (const [vendorOrderId, group] of groups) {
    if (group.length < 2) continue;

    // Oldest row survives; every other field is unioned/coalesced onto it below.
    const [survivor, ...losers] = group;

    await sequelize.transaction(async (t) => {
      const largestTotalOrder = group.reduce<ExternalOrder | null>((best, o) => {
        const n = numberOrNull(o.total);
        if (n == null) return best;
        const bestN = best == null ? null : numberOrNull(best.total);
        return bestN == null || n > bestN ? o : best;
      }, null);

      await survivor.update(
        {
          // Keep the original string value (never reconstruct via Number/toFixed)
          // so we don't lose precision on a DECIMAL(14,4) column.
          total: largestTotalOrder ? largestTotalOrder.total : survivor.total,
          orderDate: survivor.orderDate ?? group.find((o) => o.orderDate != null)?.orderDate ?? null,
          paymentLast4:
            survivor.paymentLast4 ?? group.find((o) => o.paymentLast4 != null)?.paymentLast4 ?? null,
          subtotal: survivor.subtotal ?? group.find((o) => o.subtotal != null)?.subtotal ?? null,
          tax: survivor.tax ?? group.find((o) => o.tax != null)?.tax ?? null,
          shipping: survivor.shipping ?? group.find((o) => o.shipping != null)?.shipping ?? null,
          shipmentDate:
            survivor.shipmentDate ?? group.find((o) => o.shipmentDate != null)?.shipmentDate ?? null,
        },
        { transaction: t },
      );

      for (const loser of losers) {
        // --- items: union onto the survivor, skipping ones already present ---
        const [survivorItems, loserItems] = await Promise.all([
          ExternalOrderItem.findAll({ where: { externalOrderId: survivor.id }, transaction: t }),
          ExternalOrderItem.findAll({ where: { externalOrderId: loser.id }, transaction: t }),
        ]);
        const have = new Set(survivorItems.map(itemDedupeKey));
        for (const item of loserItems) {
          const key = itemDedupeKey(item);
          if (have.has(key)) {
            await item.destroy({ transaction: t });
          } else {
            have.add(key);
            await item.update({ externalOrderId: survivor.id }, { transaction: t });
          }
        }

        // --- transaction<->order links: re-parent, resolving same-transaction conflicts ---
        const loserLinks = await TransactionOrderLink.findAll({
          where: { externalOrderId: loser.id },
          transaction: t,
        });
        for (const link of loserLinks) {
          const existing = await TransactionOrderLink.findOne({
            where: { transactionId: link.transactionId, externalOrderId: survivor.id },
            transaction: t,
          });
          if (!existing) {
            await link.update({ externalOrderId: survivor.id }, { transaction: t });
            continue;
          }
          if (linkPrecedence(link) > linkPrecedence(existing)) {
            await existing.update(
              {
                confidence: link.confidence,
                matchReason: link.matchReason,
                status: link.status,
                linkedAmount: link.linkedAmount,
              },
              { transaction: t },
            );
          }
          await link.destroy({ transaction: t });
        }

        // --- receipts & tenders: re-parent so nothing gets orphaned/nulled ---
        await Receipt.update(
          { externalOrderId: survivor.id },
          { where: { externalOrderId: loser.id }, transaction: t },
        );
        await ExternalOrderTender.update(
          { externalOrderId: survivor.id },
          { where: { externalOrderId: loser.id }, transaction: t },
        );

        await loser.destroy({ transaction: t });
      }
      merged += 1;
    });

    logger.info({ vendorOrderId, folded: losers.length }, 'amazon_duplicate_orders_merged');
  }

  return { merged };
}

function numberOrNull(value: unknown): number | null {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function itemDedupeKey(item: { title: string; totalPrice: string | null; quantity: number }): string {
  return `${item.title}|${item.totalPrice}|${item.quantity}`;
}

const STATUS_RANK: Record<string, number> = { accepted: 3, rejected: 2, suggested: 1 };

/** Higher wins a conflict: an explicit user decision (accepted/rejected) beats
 * a mere suggestion, and within the same status a higher confidence wins. */
function linkPrecedence(link: { status: string; confidence: string }): number {
  const statusRank = STATUS_RANK[link.status] ?? 0;
  const confidence = numberOrNull(link.confidence) ?? 0;
  return statusRank * 1000 + confidence;
}
