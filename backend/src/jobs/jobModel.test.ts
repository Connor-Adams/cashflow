import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';

let models: typeof import('../models');

before(async () => {
  models = await import('../models');
  await models.sequelize.sync();
});

after(async () => { await models.sequelize.close(); });

test('Job upserts a row keyed by name', async () => {
  await models.Job.upsert({
    name: 'test_job_a',
    enabledOverride: null,
    cronOverride: null,
    lastRunAt: null,
    lastFinishedAt: null,
    lastStatus: null,
    lastDurationMs: null,
    lastError: null,
    lastResultJson: null,
  });
  const row = await models.Job.findOne({ where: { name: 'test_job_a' } });
  assert.ok(row);
  assert.equal(row.enabledOverride, null);
  assert.equal(row.cronOverride, null);
});

test('Job round-trips status fields', async () => {
  await models.Job.upsert({
    name: 'test_job_b',
    enabledOverride: true,
    cronOverride: '*/5 * * * *',
    lastRunAt: new Date('2026-05-26T10:00:00Z'),
    lastFinishedAt: new Date('2026-05-26T10:00:01Z'),
    lastStatus: 'ok',
    lastDurationMs: 1234,
    lastError: null,
    lastResultJson: JSON.stringify({ processed: 3 }),
  });
  const row = await models.Job.findOne({ where: { name: 'test_job_b' } });
  assert.ok(row);
  assert.equal(row.lastStatus, 'ok');
  assert.equal(row.lastDurationMs, 1234);
  assert.equal(row.cronOverride, '*/5 * * * *');
});
