import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';

let models: typeof import('../models');
let registry: typeof import('./registry');

before(async () => {
  models = await import('../models');
  await models.sequelize.sync();
  registry = await import('./registry');
});

after(async () => {
  registry.stopAllJobs();
  await models.sequelize.close();
});

beforeEach(async () => {
  registry.__resetForTest();
  await models.Job.destroy({ where: {}, truncate: true });
});

test('defineJob registers definition and listJobs returns view', async () => {
  registry.defineJob({
    name: 'reg_a',
    cronDefault: '*/4 * * * *',
    enabledDefault: true,
    handler: async () => ({}),
  });
  const views = await registry.listJobs();
  assert.equal(views.length, 1);
  assert.equal(views[0].name, 'reg_a');
  assert.equal(views[0].cron, '*/4 * * * *');
  assert.equal(views[0].enabled, true);
  assert.equal(views[0].source.enabled, 'env');
  assert.ok(views[0].nextRunAt && new Date(views[0].nextRunAt).getTime() > Date.now());
});

test('duplicate defineJob throws', async () => {
  registry.defineJob({
    name: 'reg_dup',
    cronDefault: '*/4 * * * *',
    enabledDefault: true,
    handler: async () => ({}),
  });
  assert.throws(() =>
    registry.defineJob({
      name: 'reg_dup',
      cronDefault: '*/5 * * * *',
      enabledDefault: false,
      handler: async () => ({}),
    }),
  );
});

test('runJobByName triggers tick and upserts row', async () => {
  let calls = 0;
  registry.defineJob({
    name: 'reg_run',
    cronDefault: '*/4 * * * *',
    enabledDefault: true,
    handler: async () => { calls += 1; return {}; },
  });
  const outcome = await registry.runJobByName('reg_run');
  assert.equal(outcome.status, 'ok');
  assert.equal(calls, 1);
});

test('runJobByName throws on unknown', async () => {
  await assert.rejects(registry.runJobByName('nope'), /unknown job/);
});

test('reconcile picks up DB cron override on next iteration', async () => {
  registry.defineJob({
    name: 'reg_reconcile',
    cronDefault: '0 3 * * *',
    enabledDefault: true,
    handler: async () => ({}),
  });
  await registry.startAllJobs({ reconcileMs: null }); // disable timer
  let views = await registry.listJobs();
  assert.equal(views[0].cron, '0 3 * * *');

  await models.Job.upsert({
    name: 'reg_reconcile',
    enabledOverride: null,
    cronOverride: '*/15 * * * *',
    lastRunAt: null, lastFinishedAt: null, lastStatus: null,
    lastDurationMs: null, lastError: null, lastResultJson: null,
  });
  await registry.reconcileOnceForTest();
  views = await registry.listJobs();
  assert.equal(views[0].cron, '*/15 * * * *');
  assert.equal(views[0].source.cron, 'db');
});
