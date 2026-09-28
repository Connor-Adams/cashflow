/**
 * Nightly cron that re-enriches review-flagged transactions household by
 * household. Catches drift between manual backfills as rules/memory churn
 * during the day — operators don't need to remember to click "Backfill" in
 * settings every morning.
 *
 * Scope is deliberately narrow: only rows with `reviewFlag = true`. The
 * coordinator's per-household lock prevents the cron from racing manual
 * runs or internal triggers, so the tick is safe even on a hot system.
 */
import { logger } from '../observability/logger';
import * as env from '../config/env';
import { Household, TransactionOrderLink } from '../models';
import { runBackfill, type BackfillResult } from './runEnrichmentBackfill';
import { isBackfillInFlight } from './backfillCoordinator';
import { recomputeTransactionsReviewFromItems } from './enrichment/recomputeTransactionReviewFromItems';

export interface EnrichmentBackfillTickResult {
  status: 'skipped_disabled' | 'ran' | 'error';
  householdsProcessed?: number;
  householdsSkipped?: number;
  totals?: BackfillResult;
  itemReview?: { recomputed: number };
  error?: string;
}

export interface EnrichmentBackfillTickConfig {
  enabled: boolean;
  /**
   * Whether this tick may run the stage-8 ai-batch over the rows the
   * deterministic stages leave cold. Defaults to
   * `ENRICHMENT_BACKFILL_AI_ENABLED` (on).
   */
  ai: boolean;
}

/** The backfill runner, injectable so tests can observe the flags the tick
 *  builds without standing up OpenAI or a full household sweep. */
export type EnrichmentBackfillTickDeps = {
  runBackfill?: typeof runBackfill;
};

function configFromEnv(): EnrichmentBackfillTickConfig {
  return {
    enabled: env.enrichmentBackfillEnabled,
    ai: env.enrichmentBackfillAiEnabled,
  };
}

export async function runEnrichmentBackfillTick(
  configOverride?: Partial<EnrichmentBackfillTickConfig>,
  deps: EnrichmentBackfillTickDeps = {},
): Promise<EnrichmentBackfillTickResult> {
  const config: EnrichmentBackfillTickConfig = { ...configFromEnv(), ...configOverride };
  if (!config.enabled) return { status: 'skipped_disabled' };
  const backfill = deps.runBackfill ?? runBackfill;

  try {
    const households = await Household.findAll({ attributes: ['id'] });
    const totals: BackfillResult = {
      processed: 0,
      updated: 0,
      reviewFlagCleared: 0,
      signalsWritten: 0,
      skipped: 0,
      aiEnhanced: 0,
    };
    let householdsProcessed = 0;
    let householdsSkipped = 0;

    for (const hh of households) {
      // Defer to whichever runner already owns the lock — manual button,
      // capture trigger, rule edit, etc. The next tick will catch up.
      if (isBackfillInFlight(hh.id)) {
        householdsSkipped += 1;
        continue;
      }
      try {
        const result = await backfill({
          dryRun: false,
          noReviewFlag: false,
          reviewOnly: true,
          verbose: false,
          accountId: null,
          householdId: hh.id,
          limit: null,
          batchSize: 100,
          dateFrom: null,
          dateTo: null,
          // The nightly cron DOES run stage 8. It used to omit `ai` to keep the
          // cron deterministic and free — but that made the only job that sees
          // every review-flagged row unable to categorise anything the literal
          // rules and exact-name memory had already missed, and production held
          // no `auto_source = 'ai'` row at all. The calls now go through a
          // self-hosted litellm proxy, so the recurring-OpenAI-cost argument no
          // longer applies, and spend per run is bounded by
          // `enrichmentAiMaxMerchants` (80) plus merchant-dedupe — the first
          // sweep is the expensive one and it tails off as memory fills.
          // `ENRICHMENT_BACKFILL_AI_ENABLED=false` switches it back off without
          // a deploy.
          ai: config.ai,
        });
        totals.processed += result.processed;
        totals.updated += result.updated;
        totals.reviewFlagCleared += result.reviewFlagCleared;
        totals.signalsWritten += result.signalsWritten;
        totals.skipped += result.skipped;
        totals.aiEnhanced += result.aiEnhanced;
        householdsProcessed += 1;
      } catch (err) {
        logger.error(
          { err, householdId: hh.id },
          'enrichment_backfill_cron_household_failed',
        );
      }
    }

    const itemReview = await backfillItemReviewClears();
    return { status: 'ran', householdsProcessed, householdsSkipped, totals, itemReview };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown error';
    return { status: 'error', error: msg };
  }
}

/** Recompute item-based review-clear for every transaction with an accepted
 *  itemized link. Idempotent. Returns count of transactions recomputed. */
export async function backfillItemReviewClears(): Promise<{ recomputed: number }> {
  const links = await TransactionOrderLink.findAll({
    where: { status: 'accepted' },
    attributes: ['transactionId'],
  });
  const ids = [...new Set(links.map((l) => (l as unknown as { transactionId: number }).transactionId))];
  await recomputeTransactionsReviewFromItems(ids);
  return { recomputed: ids.length };
}

