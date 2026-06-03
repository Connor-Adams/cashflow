import { Op } from 'sequelize';
import { TransactionOrderLink } from '../models';

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
