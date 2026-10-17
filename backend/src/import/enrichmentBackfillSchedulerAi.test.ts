/**
 * The nightly enrichment backfill used to omit the AI cold-row stage outright
 * ("nightly cron stays deterministic — no recurring OpenAI cost"), so the job
 * that sweeps every review-flagged row every night reported `aiEnhanced: 0`
 * forever: not because nothing was categorisable, but because it was never
 * allowed to try. Production `auto_source` held no `ai` row at all.
 *
 * This file locks the ON state. The OFF switch (env override) is
 * `enrichmentBackfillSchedulerAiDisabled.test.ts`, which needs its own process
 * to set the env var before config/env is imported.
 */
import { before, beforeEach, after, test } from 'node:test';
import assert from 'node:assert/strict';

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

const EMPTY: BackfillResult = {
  processed: 0,
  updated: 0,
  reviewFlagCleared: 0,
  signalsWritten: 0,
  skipped: 0,
  aiEnhanced: 0,
};

function recordingRunner(seen: BackfillFlags[]) {
  return async (flags: BackfillFlags): Promise<BackfillResult> => {
    seen.push(flags);
    return { ...EMPTY };
  };
}

test('the nightly tick asks for the AI cold-row stage', async () => {
  await models.Household.create({ name: 'Nightly HH' } as never);
  const seen: BackfillFlags[] = [];

  const result = await scheduler.runEnrichmentBackfillTick(
    { enabled: true },
    { runBackfill: recordingRunner(seen) },
  );

  assert.equal(result.status, 'ran');
  assert.equal(seen.length, 1, 'one household → one backfill');
  assert.equal(seen[0].ai, true, 'the nightly cron must be allowed to run stage 8');
});

test('the AI flag can be switched off per-tick without touching the other flags', async () => {
  await models.Household.create({ name: 'Nightly HH' } as never);
  const seen: BackfillFlags[] = [];

  await scheduler.runEnrichmentBackfillTick(
    { enabled: true, ai: false },
    { runBackfill: recordingRunner(seen) },
  );

  assert.equal(seen.length, 1);
  assert.equal(seen[0].ai, false);
  // The rest of the nightly shape is unchanged: review-flagged rows only, real
  // writes, no dry run (a dry run would suppress AI regardless).
  assert.equal(seen[0].reviewOnly, true);
  assert.equal(seen[0].dryRun, false);
});

test('every household in the tick gets the AI flag, not just the first', async () => {
  await models.Household.create({ name: 'HH one' } as never);
  await models.Household.create({ name: 'HH two' } as never);
  const seen: BackfillFlags[] = [];

  await scheduler.runEnrichmentBackfillTick(
    { enabled: true },
    { runBackfill: recordingRunner(seen) },
  );

  assert.equal(seen.length, 2);
  assert.deepEqual(
    seen.map((f) => f.ai),
    [true, true],
  );
});
