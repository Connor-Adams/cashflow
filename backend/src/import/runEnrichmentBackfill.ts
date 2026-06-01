/**
 * runEnrichmentBackfill — core re-enrichment routine reusable from CLI and HTTP.
 *
 * Safety:
 *  - Never touches *_override columns.
 *  - Never touches reviewed_at.
 *  - review_flag is only flipped to false on previously-unreviewed rows where the
 *    pipeline produces a non-AI high-confidence category. Already-reviewed rows
 *    keep their current review_flag.
 *  - Idempotent: re-running on the same DB yields the same result.
 *
 * Caller-supplied flags control filtering and write behaviour.
 */
import { logger } from '../observability/logger';
import { Op } from 'sequelize';
import { sequelize, Transaction, TransactionSignal } from '../models';
import { loadAllRules } from './applyRules';
import { findMerchantMemory } from '../ai/merchantMemory';
import { caseInsensitiveLikeOp } from '../ai/chat/_common';
import { enrichTransaction } from './enrich';
import { upsertSuggestedOrderLink } from '../amazon/matcher';
import {
  loadAmazonOrdersCache,
  loadHouseholdAccountIds,
  loadHouseholdOwnerNames,
  loadRecurringHistory,
  loadRelationshipCandidates,
} from './enrichment/loaders';
import {
  enrichmentRecurringMinSupport,
  enrichmentAmazonLinkThreshold,
  enrichmentRefundWindowDays,
  enrichmentTransferWindowDays,
} from '../config/env';
import { recomputeTransactionAmounts } from './calculateShares';
import { runBackfillBatchTrace } from './backfillTrace';

export interface BackfillFlags {
  dryRun: boolean;
  noReviewFlag: boolean;
  reviewOnly: boolean;
  verbose: boolean;
  accountId: number | null;
  householdId: number | null;
  limit: number | null;
  batchSize: number;
  /** Optional: enrich only this single transaction id (used by the single-row re-enrich route). */
  transactionId?: number | null;
  /** Inclusive lower bound on Transaction.date (YYYY-MM-DD). */
  dateFrom: string | null;
  /** Inclusive upper bound on Transaction.date (YYYY-MM-DD). */
  dateTo: string | null;
  /**
   * Optional case-insensitive substring filter on merchantClean OR merchantRaw.
   * Cheap pre-filter for rule/memory-triggered backfills so we don't sweep the
   * whole household when only one merchant changed. Pipeline still re-evaluates
   * every loaded row, so over-selection is safe — under-selection is not.
   */
  merchantPattern?: string | null;
}

export interface BackfillResult {
  processed: number;
  updated: number;
  reviewFlagCleared: number;
  signalsWritten: number;
  skipped: number;
}

export interface BackfillProgressEvent {
  txnId: number;
  merchantRaw: string;
  merchantClean: string;
  merchantCanonical: string | null;
  txnType: string;
  autoSource: string | null;
  autoConfidence: string | null;
  reviewFlagCleared: boolean;
  signalsCount: number;
}

export interface BackfillCallbacks {
  /** Called after each row is processed (or attempted). */
  onProgress?: (e: BackfillProgressEvent) => void;
  /** Called when a row fails. Backfill continues to the next row. */
  onError?: (e: { txnId: number; message: string }) => void;
}

export async function runBackfill(
  flags: BackfillFlags,
  callbacks: BackfillCallbacks = {},
): Promise<BackfillResult> {
  const rulesByHousehold = new Map<string, Awaited<ReturnType<typeof loadAllRules>>>();
  const amazonByHousehold = new Map<string, Awaited<ReturnType<typeof loadAmazonOrdersCache>>>();
  const householdAccountIdsByAccount = new Map<number, number[]>();

  const householdKey = (hh: number | null) => (hh == null ? 'null' : String(hh));
  async function getRules(hh: number | null) {
    const k = householdKey(hh);
    if (!rulesByHousehold.has(k)) rulesByHousehold.set(k, await loadAllRules(hh ?? undefined));
    return rulesByHousehold.get(k)!;
  }
  async function getAmazonOrders(hh: number | null) {
    const k = householdKey(hh);
    if (!amazonByHousehold.has(k)) amazonByHousehold.set(k, await loadAmazonOrdersCache(hh));
    return amazonByHousehold.get(k)!;
  }
  async function getHouseholdAccountIds(accountId: number, hh: number | null) {
    if (!householdAccountIdsByAccount.has(accountId)) {
      householdAccountIdsByAccount.set(accountId, await loadHouseholdAccountIds(accountId, hh));
    }
    return householdAccountIdsByAccount.get(accountId)!;
  }

  const ownerNamesByHousehold = new Map<string, string[]>();
  async function getOwnerNames(hh: number | null) {
    const k = householdKey(hh);
    if (!ownerNamesByHousehold.has(k)) {
      ownerNamesByHousehold.set(k, await loadHouseholdOwnerNames(hh));
    }
    return ownerNamesByHousehold.get(k)!;
  }

  const where: Record<string, unknown> = {};
  if (flags.transactionId != null) where.id = flags.transactionId;
  if (flags.accountId != null) where.accountId = flags.accountId;
  if (flags.householdId != null) where.householdId = flags.householdId;
  if (flags.reviewOnly) where.reviewFlag = true;

  if (flags.dateFrom && flags.dateTo) {
    where.date = { [Op.between]: [flags.dateFrom, flags.dateTo] };
  } else if (flags.dateFrom) {
    where.date = { [Op.gte]: flags.dateFrom };
  } else if (flags.dateTo) {
    where.date = { [Op.lte]: flags.dateTo };
  }

  if (flags.merchantPattern && flags.merchantPattern.trim().length > 0) {
    const likeOp = caseInsensitiveLikeOp();
    const needle = `%${flags.merchantPattern.trim()}%`;
    where[Op.or as unknown as string] = [
      { merchantClean: { [likeOp]: needle } },
      { merchantRaw: { [likeOp]: needle } },
    ];
  }

  const total = await Transaction.count({ where });
  logger.info({ total, module: 'enrichment_backfill' }, 'backfill_started');

  let processed = 0;
  let updated = 0;
  let reviewFlagCleared = 0;
  let signalsWritten = 0;
  let skipped = 0;
  let offset = 0;
  let batchIndex = 0;

  while (true) {
    if (flags.limit != null && processed >= flags.limit) break;

    const remainingBudget = flags.limit != null ? flags.limit - processed : Infinity;
    const take = Math.min(flags.batchSize, remainingBudget);

    const txns = await Transaction.findAll({
      where,
      order: [
        ['date', 'ASC'],
        ['id', 'ASC'],
      ],
      limit: take,
      offset,
    });
    if (txns.length === 0) break;

    batchIndex++;
    const batchProcessedStart = processed;
    const batchUpdatedStart = updated;
    const batchReviewFlagClearedStart = reviewFlagCleared;
    const batchSignalsWrittenStart = signalsWritten;
    const batchSkippedStart = skipped;

    await runBackfillBatchTrace(
      {
        householdId: flags.householdId,
        batchIndex,
        batchSize: txns.length,
        offset,
        total,
        dryRun: flags.dryRun,
      },
      async (span) => {
        for (const txn of txns) {
          processed++;

          try {
            const rules = await getRules(txn.householdId);
            const amazonOrders = await getAmazonOrders(txn.householdId);
            const householdAccountIds = await getHouseholdAccountIds(
              txn.accountId,
              txn.householdId,
            );
            const ownerNames = await getOwnerNames(txn.householdId);
            const memory = await findMerchantMemory(
              txn.householdId,
              txn.merchantClean,
              Number(txn.amount),
            );
            const recurringHistory = await loadRecurringHistory(
              txn.householdId,
              txn.merchantClean,
              txn.date,
            );
            const relationshipCandidatesRaw = await loadRelationshipCandidates(
              txn.householdId,
              householdAccountIds,
              txn.merchantClean,
              txn.date,
              enrichmentRefundWindowDays,
            );
            // Exclude self — otherwise a transfer or refund row could "link to itself".
            const relationshipCandidates = relationshipCandidatesRaw.filter(
              (c) => c.id !== txn.id,
            );

            const enriched = await enrichTransaction({
              raw: {
                merchantRaw: txn.merchantRaw,
                date: txn.date,
                amount: Number(txn.amount),
                sourceReference: txn.sourceReference ?? null,
                notes: null,
              },
              accountId: txn.accountId,
              householdId: txn.householdId,
              householdAccountIds,
              ownerNames,
              rules,
              amazonOrders,
              memory,
              recurringHistory,
              relationshipCandidates,
              refundWindowDays: enrichmentRefundWindowDays,
              transferWindowDays: enrichmentTransferWindowDays,
              recurringMinSupport: enrichmentRecurringMinSupport,
              amazonLinkThreshold: enrichmentAmazonLinkThreshold,
            });

            const f = enriched.fields;

            let willClearReview = false;
            if (
              !flags.noReviewFlag &&
              txn.reviewedAt == null &&
              f.reviewFlag === false &&
              txn.reviewFlag === true
            ) {
              willClearReview = true;
            }

            if (flags.verbose) {
              logger.debug(
                {
                  txnId: txn.id,
                  date: txn.date,
                  merchantRaw: txn.merchantRaw,
                  merchantClean: f.merchantClean,
                  merchantCanonical: f.merchantCanonical ?? null,
                  txnType: f.txnType,
                  autoSource: f.autoSource ?? null,
                  autoConfidence: f.autoConfidence ?? null,
                  signalsCount: enriched.signals.length,
                  willClearReview,
                  module: 'enrichment_backfill',
                },
                'backfill_txn_enriched',
              );
            }

            if (flags.dryRun) {
              updated++;
              if (willClearReview) reviewFlagCleared++;
              signalsWritten += enriched.signals.length;
              callbacks.onProgress?.({
                txnId: txn.id,
                merchantRaw: txn.merchantRaw,
                merchantClean: f.merchantClean,
                merchantCanonical: f.merchantCanonical,
                txnType: f.txnType,
                autoSource: f.autoSource,
                autoConfidence: f.autoConfidence,
                reviewFlagCleared: willClearReview,
                signalsCount: enriched.signals.length,
              });
              continue;
            }

            await sequelize.transaction(async (t) => {
              txn.set({
                merchantClean: f.merchantClean,
                merchantCanonical: f.merchantCanonical,
                txnType: f.txnType,
                autoSource: f.autoSource,
                autoConfidence: f.autoConfidence,
                autoCategory: f.autoCategory,
                autoBusiness: f.autoBusiness,
                autoSplitType: f.autoSplitType,
                autoPctMe: f.autoPctMe,
                autoPctPartner: f.autoPctPartner,
                appliedRuleId: f.appliedRuleId,
                linkedTransactionId: f.linkedTransactionId,
                isRecurring: f.isRecurring,
              });
              // Only fill notes if the row had none — don't overwrite user-authored notes.
              if (!txn.notes && f.notes) {
                txn.set({ notes: f.notes });
              }
              if (willClearReview) {
                txn.set({ reviewFlag: false });
              }

              recomputeTransactionAmounts(txn);
              await txn.save({ transaction: t });

              await TransactionSignal.destroy({
                where: { transactionId: txn.id },
                transaction: t,
              });
              if (enriched.signals.length > 0) {
                await TransactionSignal.bulkCreate(
                  enriched.signals.map((s) => ({
                    transactionId: txn.id,
                    source: s.source,
                    confidence: s.confidence,
                    fields: s.fields,
                    rationale: s.rationale ?? null,
                  })),
                  { transaction: t },
                );
              }

              // Persist the item-link match through the canonical
              // TransactionOrderLink join table (status 'suggested'). Idempotent,
              // and never resurrects a link the user has already rejected.
              const orderLink = enriched.signals.find((s) => s.orderLink)?.orderLink;
              if (orderLink) {
                await upsertSuggestedOrderLink({
                  transactionId: txn.id,
                  externalOrderId: orderLink.externalOrderId,
                  confidence: orderLink.confidence,
                  matchReason: orderLink.matchReason,
                  transaction: t,
                });
              }
            });

            updated++;
            if (willClearReview) reviewFlagCleared++;
            signalsWritten += enriched.signals.length;

            callbacks.onProgress?.({
              txnId: txn.id,
              merchantRaw: txn.merchantRaw,
              merchantClean: f.merchantClean,
              merchantCanonical: f.merchantCanonical,
              txnType: f.txnType,
              autoSource: f.autoSource,
              autoConfidence: f.autoConfidence,
              reviewFlagCleared: willClearReview,
              signalsCount: enriched.signals.length,
            });
          } catch (err) {
            skipped++;
            const message = err instanceof Error ? err.message : String(err);
            logger.error(
              { err, txnId: txn.id, module: 'enrichment_backfill' },
              'backfill_txn_failed',
            );
            callbacks.onError?.({ txnId: txn.id, message });
          }
        }

        span.setAttributes({
          'cashflow.backfill.batch_processed': processed - batchProcessedStart,
          'cashflow.backfill.batch_updated': updated - batchUpdatedStart,
          'cashflow.backfill.batch_review_flag_cleared':
            reviewFlagCleared - batchReviewFlagClearedStart,
          'cashflow.backfill.batch_signals_written': signalsWritten - batchSignalsWrittenStart,
          'cashflow.backfill.batch_skipped': skipped - batchSkippedStart,
        });
      },
    );

    offset += txns.length;

    if (processed % 100 === 0 || processed === total) {
      logger.info(
        {
          processed,
          total,
          updated,
          reviewFlagCleared,
          skipped,
          dryRun: flags.dryRun,
          module: 'enrichment_backfill',
        },
        'backfill_progress',
      );
    }
  }

  return { processed, updated, reviewFlagCleared, signalsWritten, skipped };
}
