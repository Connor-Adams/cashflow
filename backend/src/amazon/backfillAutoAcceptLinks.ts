import { Op } from 'sequelize';
import { Transaction, TransactionOrderLink } from '../models';
import { decideAutoAccept } from './autoAccept';
import { isAmazonLikeMerchant } from './matcher';
import {
  recomputeTransactionsReviewFromItems,
  transactionIdsForOrder,
} from '../import/enrichment/recomputeTransactionReviewFromItems';

/**
 * One-shot promotion of pre-existing 'suggested' Amazon links created before
 * auto-accept existed. A transaction's links are promoted only when there is
 * exactly ONE suggested link for it and that link clears decideAutoAccept —
 * the same unambiguity rule runAmazonMatching applies live. Idempotent:
 * already-accepted/rejected links are ignored.
 */
export async function backfillAutoAcceptAmazonLinks(args: {
  householdId: number;
}): Promise<{ promoted: number; examined: number }> {
  const txns = await Transaction.findAll({ where: { householdId: args.householdId } });
  const amazonTxnIds = txns
    .filter((t) => isAmazonLikeMerchant(`${t.merchantRaw} ${t.merchantClean}`))
    .map((t) => t.id);
  if (amazonTxnIds.length === 0) return { promoted: 0, examined: 0 };

  const suggested = await TransactionOrderLink.findAll({
    where: { transactionId: { [Op.in]: amazonTxnIds }, status: 'suggested' },
  });

  const byTxn = new Map<number, TransactionOrderLink[]>();
  for (const l of suggested) {
    const list = byTxn.get(l.transactionId) ?? [];
    list.push(l);
    byTxn.set(l.transactionId, list);
  }

  let promoted = 0;
  const acceptedOrderIds = new Set<number>();
  for (const [, links] of byTxn) {
    if (links.length !== 1) continue; // ambiguous — leave for manual review
    const link = links[0];
    if (!decideAutoAccept([Number(link.confidence)])) continue;
    await link.update({ status: 'accepted' });
    promoted += 1;
    acceptedOrderIds.add(link.externalOrderId);
  }

  for (const orderId of acceptedOrderIds) {
    await recomputeTransactionsReviewFromItems(await transactionIdsForOrder(orderId));
  }

  return { promoted, examined: suggested.length };
}
