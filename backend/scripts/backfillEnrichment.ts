#!/usr/bin/env tsx
/**
 * backfillEnrichment.ts
 *
 * Re-runs the import-time enrichment pipeline against every existing
 * transaction and writes back the new auto_* fields, merchant_clean,
 * merchant_canonical, txn_type, is_recurring, linked_transaction_id, and
 * transaction_signals.
 *
 * Safety:
 *  - Never touches *_override columns.
 *  - Never touches reviewed_at.
 *  - review_flag is only updated for rows where reviewed_at IS NULL AND the
 *    pipeline now produces a non-AI high-confidence category. It is set to
 *    false (cleared). Reviewed rows always keep their current review_flag.
 *  - --dry-run reports what would change without writing.
 *  - Idempotent: re-running on the same DB yields the same result.
 *
 * Flags:
 *   --dry-run            print would-update count, write nothing
 *   --no-review-flag     don't touch review_flag (only enrich descriptive fields)
 *   --review-only        only re-enrich rows currently in review (review_flag=true)
 *   --account-id N       filter to one account
 *   --household-id N     filter to one household
 *   --limit N            process at most N rows (useful for testing on prod)
 *   --batch-size N       fetch batch size (default 100)
 *   --verbose            print per-row decision
 *
 * Usage on Railway:
 *   railway run --service backend yarn workspace cashflow-backend tsx scripts/backfillEnrichment.ts --dry-run
 *   railway run --service backend yarn workspace cashflow-backend tsx scripts/backfillEnrichment.ts
 */
import { sequelize, Transaction, TransactionSignal } from '../src/models';
import { loadAllRules } from '../src/import/applyRules';
import { findMerchantMemory } from '../src/ai/merchantMemory';
import { enrichTransaction } from '../src/import/enrich';
import {
  loadAmazonOrdersCache,
  loadHouseholdAccountIds,
  loadRecurringHistory,
  loadRelationshipCandidates,
} from '../src/import/enrichment/loaders';
import {
  enrichmentRecurringMinSupport,
  enrichmentAmazonLinkThreshold,
  enrichmentRefundWindowDays,
  enrichmentTransferWindowDays,
} from '../src/config/env';
import { recomputeTransactionAmounts } from '../src/import/calculateShares';

interface Flags {
  dryRun: boolean;
  noReviewFlag: boolean;
  reviewOnly: boolean;
  verbose: boolean;
  accountId: number | null;
  householdId: number | null;
  limit: number | null;
  batchSize: number;
}

function parseFlags(argv: string[]): Flags {
  function intFlag(name: string): number | null {
    const idx = argv.indexOf(name);
    if (idx === -1 || idx === argv.length - 1) return null;
    const n = Number(argv[idx + 1]);
    return Number.isFinite(n) ? n : null;
  }
  return {
    dryRun: argv.includes('--dry-run'),
    noReviewFlag: argv.includes('--no-review-flag'),
    reviewOnly: argv.includes('--review-only'),
    verbose: argv.includes('--verbose'),
    accountId: intFlag('--account-id'),
    householdId: intFlag('--household-id'),
    limit: intFlag('--limit'),
    batchSize: intFlag('--batch-size') ?? 100,
  };
}

export async function runBackfill(flags: Flags): Promise<{
  processed: number;
  updated: number;
  reviewFlagCleared: number;
  signalsWritten: number;
  skipped: number;
}> {
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

  const where: Record<string, unknown> = {};
  if (flags.accountId != null) where.accountId = flags.accountId;
  if (flags.householdId != null) where.householdId = flags.householdId;
  if (flags.reviewOnly) where.reviewFlag = true;

  const total = await Transaction.count({ where });
  console.log(`[backfill] ${total} transactions match filter`);

  let processed = 0;
  let updated = 0;
  let reviewFlagCleared = 0;
  let signalsWritten = 0;
  let skipped = 0;
  let offset = 0;

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

    for (const txn of txns) {
      processed++;

      try {
        const rules = await getRules(txn.householdId);
        const amazonOrders = await getAmazonOrders(txn.householdId);
        const householdAccountIds = await getHouseholdAccountIds(txn.accountId, txn.householdId);
        const memory = await findMerchantMemory(txn.householdId, txn.merchantClean);
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
        const relationshipCandidates = relationshipCandidatesRaw.filter((c) => c.id !== txn.id);

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
          console.log(
            `[backfill] txn ${txn.id} (${txn.date} "${txn.merchantRaw}") -> clean="${f.merchantClean}" canonical=${f.merchantCanonical ?? '-'} type=${f.txnType} source=${f.autoSource ?? '-'} conf=${f.autoConfidence ?? '-'} signals=${enriched.signals.length}${willClearReview ? ' clearReview' : ''}`,
          );
        }

        if (flags.dryRun) {
          updated++;
          if (willClearReview) reviewFlagCleared++;
          signalsWritten += enriched.signals.length;
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
        });

        updated++;
        if (willClearReview) reviewFlagCleared++;
        signalsWritten += enriched.signals.length;
      } catch (err) {
        skipped++;
        console.error(`[backfill] txn ${txn.id} failed:`, err);
      }
    }

    offset += txns.length;

    if (processed % 100 === 0 || processed === total) {
      console.log(
        `[backfill] progress ${processed}/${total} updated=${updated} reviewCleared=${reviewFlagCleared} skipped=${skipped}${flags.dryRun ? ' (DRY)' : ''}`,
      );
    }
  }

  return { processed, updated, reviewFlagCleared, signalsWritten, skipped };
}

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  console.log('[backfill] starting with flags:', flags);
  const result = await runBackfill(flags);
  console.log(
    `[backfill] done: processed=${result.processed} updated=${result.updated} reviewCleared=${result.reviewFlagCleared} signalsWritten=${result.signalsWritten} skipped=${result.skipped}${flags.dryRun ? ' (DRY RUN, no writes)' : ''}`,
  );
  await sequelize.close();
}

// Only run main when invoked as a script, not when imported by tests.
const argv1 = process.argv[1] ?? '';
if (argv1.endsWith('backfillEnrichment.ts') || argv1.endsWith('backfillEnrichment.js')) {
  main().catch((err) => {
    console.error('[backfill] failed:', err);
    process.exit(1);
  });
}
