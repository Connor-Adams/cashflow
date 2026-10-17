/**
 * The nightly AI cold-row stage must be switchable off from the environment —
 * no redeploy, no code change — because it is the only stage in the pipeline
 * that spends money per run. This file owns the OFF case; it must set the env
 * var before `config/env` is imported anywhere, which is why it is its own
 * file (node:test gives each test file its own process).
 */
import { before, beforeEach, after, test } from 'node:test';
import assert from 'node:assert/strict';

process.env.ENRICHMENT_BACKFILL_AI_ENABLED = 'false';

import type { BackfillFlags, BackfillResult } from './runEnrichmentBackfill';

let models: typeof import('../models');
let scheduler: typeof import('./enrichmentBackfillScheduler');

before(async () => {
  models = await import('../models');
  await models.sequelize.sync({ force: true });
  scheduler = await import('./enrichmentBackfillScheduler');
});

after(async () => {
  await models.sequelize.close();
});

beforeEach(async () => {
  await models.sequelize.sync({ force: true });
});

test('ENRICHMENT_BACKFILL_AI_ENABLED=false stops the nightly cron asking for AI', async () => {
  await models.Household.create({ name: 'Nightly HH' } as never);
  const seen: BackfillFlags[] = [];

  const result = await scheduler.runEnrichmentBackfillTick(
    { enabled: true },
    {
      runBackfill: async (flags: BackfillFlags): Promise<BackfillResult> => {
        seen.push(flags);
        return {
          processed: 0,
          updated: 0,
          reviewFlagCleared: 0,
          signalsWritten: 0,
          skipped: 0,
          aiEnhanced: 0,
        };
      },
    },
  );

  assert.equal(result.status, 'ran');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].ai, false, 'the env kill switch must reach the flags');
});
