import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';

let models: typeof import('../../src/models');
let resolver: typeof import('../../src/jobs/configResolver');
let types: typeof import('../../src/jobs/types');

const DEF: import('../../src/jobs/types').JobDefinition = {
  name: 'resolver_test_job',
  cronDefault: '0 3 * * *',
  enabledDefault: true,
  handler: async () => ({}),
};

before(async () => {
  models = await import('../../src/models');
  await models.sequelize.sync();
  resolver = await import('../../src/jobs/configResolver');
  types = await import('../../src/jobs/types');
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
