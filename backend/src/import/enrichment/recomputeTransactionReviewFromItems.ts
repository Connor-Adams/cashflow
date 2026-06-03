import { logger } from '../../observability/logger';
import {
  Transaction,
  TransactionSignal,
  TransactionOrderLink,
  ExternalOrder,
  ExternalOrderItem,
  Account,
} from '../../models';
import { mergeSignals } from './computeReviewFlag';
import { transactionClearsFromItems, type ItemClearInput } from './transactionClearsFromItems';
import { computeImportConfidence, serializeFlags } from '../computeImportConfidence';
import { enrichmentItemClearConfidence } from '../../config/env';
import type { Signal } from './types';

function toNumber(v: unknown): number | null {
  if (v == null) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Recompute a transaction's review state from its receipt items, OR'd onto the
 * signal-based baseline. Best-effort: errors are logged, the row is untouched.
 */
export async function recomputeTransactionReviewFromItems(txnId: number): Promise<void> {
  try {
    const txn = await Transaction.findByPk(txnId, {
      include: [
        { model: TransactionSignal, as: 'enrichmentSignals' },
        { model: Account, as: 'account' },
        {
          model: TransactionOrderLink,
          as: 'orderLinks',
          include: [
            {
              model: ExternalOrder,
              as: 'order',
              include: [{ model: ExternalOrderItem, as: 'items' }],
            },
          ],
        },
      ],
    });
    if (txn == null) return;

    const signals: Signal[] = (
      (
        txn as unknown as {
          enrichmentSignals?: Array<{
            source: string;
            confidence: string;
            fields: Record<string, unknown>;
            rationale?: string | null;
          }>;
        }
      ).enrichmentSignals ?? []
    ).map((s) => ({
      source: s.source as Signal['source'],
      confidence: s.confidence as Signal['confidence'],
      fields: s.fields as Signal['fields'],
      ...(s.rationale ? { rationale: s.rationale } : {}),
    }));

    // Re-derive the baseline statelessly from persisted signals (NOT from the
    // stored reviewFlag column) so that an override removal correctly re-flags.
    const mergedFields = signals.length > 0 ? mergeSignals(signals).fields : null;
    const baselineReviewFlag = mergedFields != null ? mergedFields.reviewFlag : txn.reviewFlag;

    const links = (
      txn as unknown as {
        orderLinks?: Array<{
          status: string;
          order?: {
            items?: Array<{
              inferredCategory: string | null;
              categoryOverride: string | null;
              confidence: unknown;
            }>;
          };
        }>;
      }
    ).orderLinks ?? [];

    const items: ItemClearInput[] = links
      .filter((l) => l.status === 'accepted')
      .flatMap((l) => l.order?.items ?? [])
      .map((i) => ({
        inferredCategory: i.inferredCategory,
        categoryOverride: i.categoryOverride,
        confidence: toNumber(i.confidence),
      }));

    const itemClear = transactionClearsFromItems(items, enrichmentItemClearConfidence);
    const reviewFlag = baselineReviewFlag && !itemClear;

    const visibility =
      (txn as unknown as { account?: { visibility?: string } }).account?.visibility === 'shared'
        ? 'shared'
        : 'private';

    // Use merged signal fields as fallback when columns haven't been written yet
    // (e.g. backfill runs before the enrichment pipeline writes auto_category).
    const autoCategory = txn.autoCategory ?? mergedFields?.autoCategory ?? null;
    const autoSplitType = txn.autoSplitType ?? mergedFields?.autoSplitType ?? null;

    const confidence = computeImportConfidence({
      reviewFlag,
      finalCategory: txn.finalCategory,
      autoCategory,
      autoSplitType,
      finalSplitType: txn.finalSplitType ?? 'me',
      txnType: txn.txnType ?? 'purchase',
      accountVisibility: visibility,
      linkedTransactionId: txn.linkedTransactionId,
      amount: txn.amount,
    });

    await Transaction.update(
      {
        reviewFlag,
        importConfidence: confidence.state,
        importConfidenceFlags: serializeFlags(confidence.flags),
      },
      { where: { id: txnId } },
    );
  } catch (err) {
    logger.warn({ err, txnId, module: 'enrichment' }, 'recompute_review_from_items_failed');
  }
}

/** Recompute many transactions, deduped. Used by mutation sites and backfill. */
export async function recomputeTransactionsReviewFromItems(
  txnIds: Iterable<number>,
): Promise<void> {
  const unique = [...new Set(txnIds)];
  for (const id of unique) {
    await recomputeTransactionReviewFromItems(id);
  }
}

/** Resolve the accepted-linked transaction ids for an order (for order-side triggers). */
export async function transactionIdsForOrder(orderId: number): Promise<number[]> {
  const links = await TransactionOrderLink.findAll({
    where: { externalOrderId: orderId, status: 'accepted' },
    attributes: ['transactionId'],
  });
  return links.map((l) => (l as unknown as { transactionId: number }).transactionId);
}
