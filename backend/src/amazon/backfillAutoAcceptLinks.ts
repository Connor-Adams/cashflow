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
 * auto-accept existed. A transaction's suggested link is promoted only when
 * the transaction has no already-accepted link AND has exactly ONE
 * non-rejected link overall (the sole suggested one) that clears
 * decideAutoAccept — the same unambiguity rule runAmazonMatching applies
 * live. This also covers a transaction whose live rescan already promoted a
 * different link to 'accepted' inline before the backfill runs: since that
 * transaction now has an accepted link, no remaining suggested link for it
 * is promoted, so a transaction never ends up with two accepted links.
 * Idempotent: already-accepted/rejected links are ignored.
 */
export async function backfillAutoAcceptAmazonLinks(args: {
  householdId: number;
}): Promise<{ promoted: number; examined: number }> {
  const txns = await Transaction.findAll({ where: { householdId: args.householdId } });
  const amazonTxnIds = txns
    .filter((t) => isAmazonLikeMerchant(`${t.merchantRaw} ${t.merchantClean}`))
    .map((t) => t.id);
  if (amazonTxnIds.length === 0) return { promoted: 0, examined: 0 };

  // Consider every non-rejected link, not just 'suggested' ones — an
  // already-'accepted' link for the transaction must veto promoting any
  // other link for it, and a rejected link should still be ignored.
  const nonRejected = await TransactionOrderLink.findAll({
    where: { transactionId: { [Op.in]: amazonTxnIds }, status: { [Op.ne]: 'rejected' } },
  });
  const suggestedCount = nonRejected.filter((l) => l.status === 'suggested').length;

  const byTxn = groupLinksByTxn(nonRejected);
  const { promoted, acceptedOrderIds } = await promoteEligibleLinks(byTxn);

  for (const orderId of acceptedOrderIds) {
    await recomputeTransactionsReviewFromItems(await transactionIdsForOrder(orderId));
  }

  return { promoted, examined: suggestedCount };
}

/** Group a flat list of non-rejected links by their transaction id. */
function groupLinksByTxn(links: TransactionOrderLink[]): Map<number, TransactionOrderLink[]> {
  const byTxn = new Map<number, TransactionOrderLink[]>();
  for (const l of links) {
    const list = byTxn.get(l.transactionId) ?? [];
    list.push(l);
    byTxn.set(l.transactionId, list);
  }
  return byTxn;
}

/**
 * Accept unambiguous, confidence-passing suggested links. A transaction is
 * eligible only when it has exactly one non-rejected link overall and that
 * link is still 'suggested' — i.e. no link for it is already 'accepted' and
 * no second suggested link makes it ambiguous. Returns counts and the
 * affected order ids.
 */
async function promoteEligibleLinks(
  byTxn: Map<number, TransactionOrderLink[]>,
): Promise<{ promoted: number; acceptedOrderIds: Set<number> }> {
  let promoted = 0;
  const acceptedOrderIds = new Set<number>();
  for (const [, links] of byTxn) {
    if (links.length !== 1) continue; // already accepted, and/or ambiguous — leave for manual review
    const link = links[0];
    if (link.status !== 'suggested') continue; // nothing to promote
    if (!decideAutoAccept([Number(link.confidence)])) continue;
    await link.update({ status: 'accepted' });
    promoted += 1;
    acceptedOrderIds.add(link.externalOrderId);
  }
  return { promoted, acceptedOrderIds };
}
