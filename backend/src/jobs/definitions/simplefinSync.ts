/**
 * SimpleFIN daily transaction sync job (issue #791).
 *
 * Runs at 02:00 UTC by default. For every connected SimpleFIN integration it
 * fetches new transactions since `lastSyncedAt` (90-day backfill on first sync)
 * and commits them through `commitStatementImport` with `profileId:'simplefin'`,
 * reusing the existing dedup. The runner (`jobs/runner.ts`) provides ticking,
 * per-job DB-backed config, and locking — this job only supplies a handler.
 */
import { defineJob } from '../registry';
import { logger } from '../../observability/logger';
import { syncSimplefin } from '../../simplefin/sync';

defineJob({
  name: 'simplefin_sync',
  cronDefault: '0 2 * * *',
  enabledDefault: true,
  handler: async () => {
    const { runs, integrationsProcessed } = await syncSimplefin();
    const inserted = runs.reduce((sum, r) => sum + r.inserted, 0);
    const skippedDuplicate = runs.reduce((sum, r) => sum + r.skippedDuplicate, 0);
    const errors = runs.filter((r) => r.status === 'error').length;
    logger.info(
      { integrationsProcessed, accountRuns: runs.length, inserted, skippedDuplicate, errors },
      'simplefin_sync_run',
    );
    return {
      summary: { integrationsProcessed, accountRuns: runs.length, inserted, skippedDuplicate, errors },
    };
  },
});
