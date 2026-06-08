import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';

let models: typeof import('../models');
let resolver: typeof import('./configResolver');
let types: typeof import('./types');

const DEF: import('./types').JobDefinition = {
  name: 'resolver_test_job',
  cronDefault: '0 3 * * *',
  enabledDefault: true,
  handler: async () => ({}),
};

before(async () => {
  models = await import('../models');
  await models.sequelize.sync();
  resolver = await import('./configResolver');
  types = await import('./types');
  void types;
});

after(async () => { await models.sequelize.close(); });

beforeEach(async () => {
  await models.Job.destroy({ where: { name: DEF.name } });
});

test('returns env defaults when no Job row exists', async () => {
  const r = await resolver.resolveJobConfig(DEF);
  assert.equal(r.enabled, true);
  assert.equal(r.cron, '0 3 * * *');
  assert.equal(r.source.enabled, 'env');
  assert.equal(r.source.cron, 'env');
});

test('Job row null overrides keep env defaults', async () => {
  await models.Job.create({
    name: DEF.name,
    enabledOverride: null,
    cronOverride: null,
    lastRunAt: null,
    lastFinishedAt: null,
    lastStatus: null,
    lastDurationMs: null,
    lastError: null,
    lastResultJson: null,
  });
  const r = await resolver.resolveJobConfig(DEF);
  assert.equal(r.source.enabled, 'env');
  assert.equal(r.source.cron, 'env');
});

test('Job row non-null overrides win', async () => {
  await models.Job.create({
    name: DEF.name,
    enabledOverride: false,
    cronOverride: '*/10 * * * *',
    lastRunAt: null, lastFinishedAt: null, lastStatus: null,
    lastDurationMs: null, lastError: null, lastResultJson: null,
  });
  const r = await resolver.resolveJobConfig(DEF);
  assert.equal(r.enabled, false);
  assert.equal(r.cron, '*/10 * * * *');
  assert.equal(r.source.enabled, 'db');
  assert.equal(r.source.cron, 'db');
});

test('mixed sources: db enabled override only, env cron', async () => {
  await models.Job.create({
    name: DEF.name,
    enabledOverride: false,
    cronOverride: null,
    lastRunAt: null, lastFinishedAt: null, lastStatus: null,
    lastDurationMs: null, lastError: null, lastResultJson: null,
  });
  const r = await resolver.resolveJobConfig(DEF);
  assert.equal(r.enabled, false);
  assert.equal(r.cron, '0 3 * * *');
  assert.equal(r.source.enabled, 'db');
  assert.equal(r.source.cron, 'env');
});
