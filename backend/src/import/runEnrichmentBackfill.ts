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
import { applyRuleSideEffects, findRuleActionsSignal } from '../rules/applyRuleSideEffects';
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
import {
  maybeRunAiBatchOverColdRows,
  type ColdRow,
} from './enrichment/aiBatchOverColdRows';
import type { ChatMessage } from './enrichment/aiBatchStage';

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
  /**
   * Run Stage 8 (ai-batch) over rows the deterministic pipeline leaves cold
   * (reviewFlag still true). Off by default so the nightly cron / CLI stay
   * deterministic with no recurring OpenAI cost; the manual backfill route sets
   * it true. Ignored on dry-run (AI never runs without persistence).
   */
  ai?: boolean;
}

export interface BackfillResult {
  processed: number;
  updated: number;
  reviewFlagCleared: number;
  signalsWritten: number;
  skipped: number;
  /**
   * Count of cold rows the ai-batch stage successfully enhanced. 0 when the
   * `ai` flag is off or on a dry-run.
   */
  aiEnhanced: number;
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
  deps: { aiCaller?: (msgs: ChatMessage[]) => Promise<Record<string, unknown>> } = {},
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
  let aiEnhanced = 0;
  // Rows fetched so far — kept for the trace attribute only. Pagination is
  // keyset-based (cursor below): the loop itself shrinks offset-based pages
  // when flags.reviewOnly (clearing review_flag drops rows from the predicate)
  // or flags.merchantPattern (rewriting merchant_clean does the same), which
  // silently skipped rows that shifted left across batches.
  let offset = 0;
  let cursor: { date: string; id: number } | null = null;
  let batchIndex = 0;

  // Stage 8 runs AFTER all per-row DB transactions (exactly like import), so
  // OpenAI latency never holds row locks. Accumulate cold rows grouped by
  // household — an admin/CLI sweep with no householdId filter can span
  // households, and the ai-batch stage (category hints, ensureCategory) is
  // per-household. The manual route is single-household so this is usually one
  // group.
  const runAi = flags.ai === true && !flags.dryRun;
  const coldRowsByHousehold = new Map<number | null, ColdRow[]>();
  const pushColdRow = (householdId: number | null, row: ColdRow) => {
    const existing = coldRowsByHousehold.get(householdId);
    if (existing) existing.push(row);
    else coldRowsByHousehold.set(householdId, [row]);
  };

  while (true) {
    if (flags.limit != null && processed >= flags.limit) break;

    const remainingBudget = flags.limit != null ? flags.limit - processed : Infinity;
    const take = Math.min(flags.batchSize, remainingBudget);

    // Keyset condition wrapped in Op.and so it never collides with the
    // merchantPattern Op.or already present on the base `where`.
    const pageWhere: Record<string, unknown> = cursor == null
      ? where
      : {
          [Op.and as unknown as string]: [
            where,
            {
              [Op.or as unknown as string]: [
                { date: { [Op.gt]: cursor.date } },
                { date: cursor.date, id: { [Op.gt]: cursor.id } },
              ],
            },
          ],
        };
    const txns = await Transaction.findAll({
      where: pageWhere,
      order: [
        ['date', 'ASC'],
        ['id', 'ASC'],
      ],
      limit: take,
    });
    if (txns.length === 0) break;
    const lastRow = txns[txns.length - 1];
    cursor = { date: lastRow.date, id: lastRow.id };

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

              // Rule actions side-effects (issue #795): re-apply labels
              // (idempotent), but do NOT re-fire alerts on a backfill — that
              // would re-notify the user for already-seen transactions.
              const ruleActions = findRuleActionsSignal(enriched.signals);
              if (ruleActions) {
                await applyRuleSideEffects({
                  ruleActions,
                  transactionId: txn.id,
                  householdId: txn.householdId,
                  transaction: t,
                  applyAlerts: false,
                });
              }
            });

            updated++;
            if (willClearReview) reviewFlagCleared++;
            signalsWritten += enriched.signals.length;

            // Accumulate cold rows for the post-loop ai-batch stage. Built the
            // same way the import path builds them (runImport.ts), so the shared
            // module sees an identical ColdRow shape.
            if (runAi && f.reviewFlag === true) {
              const key = (f.merchantCanonical ?? '').trim() || f.merchantClean.trim();
              if (key.length > 0) {
                pushColdRow(txn.householdId, {
                  txnId: txn.id,
                  signals: enriched.signals,
                  merchantKey: key,
                  merchantRaw: txn.merchantRaw,
                  merchantClean: f.merchantClean,
                  merchantCanonical: f.merchantCanonical,
                  amount: Number(txn.amount),
                  date: txn.date,
                  currency: txn.currency,
                  memory,
                  accountVisibility: txn.visibility === 'shared' ? 'shared' : 'private',
                  txnType: f.txnType,
                });
              }
            }

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

  // === Stage 8: ai-batch over cold rows ===
  // Runs outside every per-row DB transaction (same as the import path) so AI
  // latency never holds locks. Gated on flags.ai && !dryRun via `runAi`; the
  // shared module also self-gates on enrichmentAiEnabled + OpenAI config, so
  // this is a no-op when AI is disabled or no rows stayed cold.
  if (runAi) {
    for (const [householdId, rows] of coldRowsByHousehold) {
      const summary = await maybeRunAiBatchOverColdRows(rows, householdId, {
        openaiCaller: deps.aiCaller,
      });
      aiEnhanced += summary.enhanced;
    }
  }

  return { processed, updated, reviewFlagCleared, signalsWritten, skipped, aiEnhanced };
}
