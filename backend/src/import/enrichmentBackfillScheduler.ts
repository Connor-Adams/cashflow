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
import { Household } from '../models';
import { runBackfill, type BackfillResult } from './runEnrichmentBackfill';
import { isBackfillInFlight } from './backfillCoordinator';

export interface EnrichmentBackfillTickResult {
  status: 'skipped_disabled' | 'ran' | 'error';
  householdsProcessed?: number;
  householdsSkipped?: number;
  totals?: BackfillResult;
  error?: string;
}

export interface EnrichmentBackfillTickConfig {
  enabled: boolean;
}

function configFromEnv(): EnrichmentBackfillTickConfig {
  return { enabled: env.enrichmentBackfillEnabled };
}

export async function runEnrichmentBackfillTick(
  configOverride?: Partial<EnrichmentBackfillTickConfig>,
): Promise<EnrichmentBackfillTickResult> {
  const config: EnrichmentBackfillTickConfig = { ...configFromEnv(), ...configOverride };
  if (!config.enabled) return { status: 'skipped_disabled' };

  try {
    const households = await Household.findAll({ attributes: ['id'] });
    const totals: BackfillResult = {
      processed: 0,
      updated: 0,
      reviewFlagCleared: 0,
      signalsWritten: 0,
      skipped: 0,
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
        const result = await runBackfill({
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
        });
        totals.processed += result.processed;
        totals.updated += result.updated;
        totals.reviewFlagCleared += result.reviewFlagCleared;
        totals.signalsWritten += result.signalsWritten;
        totals.skipped += result.skipped;
        householdsProcessed += 1;
      } catch (err) {
        logger.error(
          'enrichment_backfill_cron_household_failed',
          { householdId: hh.id },
          err instanceof Error ? err : new Error(String(err)),
        );
      }
    }

    return { status: 'ran', householdsProcessed, householdsSkipped, totals };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown error';
    return { status: 'error', error: msg };
  }
}

