import { Op } from 'sequelize';
import { ExternalOrderItem, TransactionOrderLink } from '../models';
import { categorizeAndApplyReceiptItems, type ReceiptOpenAiCaller } from './categorizeReceiptItems';
import {
  recomputeTransactionsReviewFromItems,
  transactionIdsForOrder,
} from './enrichment/recomputeTransactionReviewFromItems';

/** Set every OTHER accepted link on this transaction to 'rejected' (photo wins).
 *  The kept order's link is untouched; rejected order rows are preserved. */
export async function supersedeAcceptedOrderLinks(
  transactionId: number,
  keepOrderId: number,
): Promise<void> {
  await TransactionOrderLink.update(
    { status: 'rejected' },
    { where: { transactionId, status: 'accepted', externalOrderId: { [Op.ne]: keepOrderId } } },
  );
}

/** Create (or promote) an accepted link from a transaction to an order. Idempotent. */
export async function linkOrderToTransaction(
  orderId: number,
  transactionId: number,
): Promise<void> {
  const [link] = await TransactionOrderLink.findOrCreate({
    where: { transactionId, externalOrderId: orderId },
    defaults: {
      transactionId,
      externalOrderId: orderId,
      status: 'accepted',
      confidence: '100',
      matchReason: 'receipt-attach',
    } as never,
  });
  if ((link as unknown as { status: string }).status !== 'accepted') {
    await link.update({ status: 'accepted' });
  }
}

/**
 * Anchor a freshly-extracted receipt order to the transaction the receipt was
 * attached to: the photo order becomes the single accepted order on that txn,
 * its items are categorized (so they gain a confidence), and review is
 * recomputed (SP1). Returns the order's item count.
 */
export async function anchorReceiptOrderToTransaction(
  args: { orderId: number; transactionId: number; householdId: number },
  opts?: { openaiCaller?: ReceiptOpenAiCaller },
): Promise<{ itemCount: number }> {
  await supersedeAcceptedOrderLinks(args.transactionId, args.orderId);
  await linkOrderToTransaction(args.orderId, args.transactionId);
  await categorizeAndApplyReceiptItems(
    { householdId: args.householdId, orderId: args.orderId },
    opts,
  );
  // categorizeAndApplyReceiptItems already calls recomputeTransactionsReviewFromItems,
  // but we call it again to ensure items that were already categorized (pre-set confidence)
  // are also considered when computing reviewFlag after the link is established.
  await recomputeTransactionsReviewFromItems(await transactionIdsForOrder(args.orderId));
  const itemCount = await ExternalOrderItem.count({ where: { externalOrderId: args.orderId } });
  return { itemCount };
}
