/**
 * SimpleFIN daily transaction sync job (issue #791).
 *
 * Runs at 02:00 UTC by default. For every connected SimpleFIN integration it
 * fetches transactions since `lastSyncedAt` minus a lookback (90-day backfill on
 * first sync) and commits them through `commitStatementImport` with
 * `profileId:'simplefin'`, reusing the existing dedup.
 *
 * The run FAILS when any account run is in error or SimpleFIN reports an
 * institution error. A broken institution still answers 200 with stale data,
 * so a run that only counted inserts recorded success every night while
 * nothing could arrive. The runner (`jobs/runner.ts`) provides ticking,
 * per-job DB-backed config, and locking — this job only supplies a handler.
 */
import { defineJob } from '../registry';
import { logger } from '../../observability/logger';
import { syncRunFailureMessage, syncSimplefin } from '../../simplefin/sync';

defineJob({
  name: 'simplefin_sync',
  cronDefault: '0 2 * * *',
  enabledDefault: true,
  handler: async () => {
    const { runs, integrationsProcessed, institutionErrors } = await syncSimplefin();
    const inserted = runs.reduce((sum, r) => sum + r.inserted, 0);
    const skippedDuplicate = runs.reduce((sum, r) => sum + r.skippedDuplicate, 0);
    const skippedCovered = runs.reduce((sum, r) => sum + r.skippedCovered, 0);
    const errors = runs.filter((r) => r.status === 'error').length;
    const summary = {
      integrationsProcessed,
      accountRuns: runs.length,
      inserted,
      skippedDuplicate,
      skippedCovered,
      errors,
      institutionErrors: institutionErrors.length,
    };
    const failure = syncRunFailureMessage({ errors, institutionErrors });
    if (failure) {
      logger.error({ ...summary, institutionErrors }, 'simplefin_sync_run_degraded');
      throw new Error(failure);
    }
    logger.info(summary, 'simplefin_sync_run');
    return { summary };
  },
});
