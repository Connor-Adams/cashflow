import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';

let models: typeof import('../models');
let runner: typeof import('./runner');
let runRetention: typeof import('./runRetention');
let types: typeof import('./types');

function makeDef(
  name: string,
  enabledDefault: boolean,
  handler: import('./types').JobHandler,
): import('./types').JobDefinition {
  return { name, cronDefault: '* * * * *', enabledDefault, handler };
}

before(async () => {
  models = await import('../models');
  await models.sequelize.sync();
  runner = await import('./runner');
  runRetention = await import('./runRetention');
  types = await import('./types');
  void types;
});

after(async () => { await models.sequelize.close(); });

beforeEach(async () => {
  await models.Job.destroy({ where: {}, truncate: true });
  await models.JobRun.destroy({ where: {}, truncate: true });
  await models.Notification.destroy({ where: {}, truncate: true });
  await models.User.destroy({ where: {}, truncate: true });
});

test('disabled job returns skipped_disabled and upserts row', async () => {
  const def = makeDef('r_disabled', false, async () => ({}));
  const r = await runner.tick(def);
  assert.equal(r.status, 'skipped_disabled');
  const row = await models.Job.findOne({ where: { name: 'r_disabled' } });
  assert.ok(row);
  assert.equal(row.lastStatus, 'skipped_disabled');
});

test('successful tick upserts ok and duration', async () => {
  const def = makeDef('r_ok', true, async () => ({ summary: { processed: 7 } }));
  const r = await runner.tick(def);
  assert.equal(r.status, 'ok');
  assert.ok(r.runId);
  assert.ok(r.queuedAt);
  const row = await models.Job.findOne({ where: { name: 'r_ok' } });
  assert.ok(row);
  assert.equal(row.lastStatus, 'ok');
  assert.ok((row.lastDurationMs ?? -1) >= 0);
  assert.ok(row.lastResultJson?.includes('"processed":7'));
  const run = await models.JobRun.findByPk(r.runId);
  assert.ok(run);
  assert.equal(run.jobName, 'r_ok');
  assert.equal(run.status, 'success');
  assert.ok(run.finishedAt);
  assert.ok((run.durationMs ?? -1) >= 0);
});

test('handler throw produces error status and truncated error', async () => {
  const def = makeDef('r_err', true, async () => {
    throw new Error('kaboom');
  });
  const r = await runner.tick(def);
  assert.equal(r.status, 'error');
  assert.ok(r.runId);
  const row = await models.Job.findOne({ where: { name: 'r_err' } });
  assert.ok(row);
  assert.equal(row.lastStatus, 'error');
  assert.ok(row.lastError?.includes('kaboom'));
  const run = await models.JobRun.findByPk(r.runId);
  assert.ok(run);
  assert.equal(run.status, 'failed');
  assert.ok(run.errorMessage?.includes('kaboom'));
});

test('concurrent ticks: second sees skipped_reentrant in-process', async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((res) => { release = res; });
  const def = makeDef('r_reentrant', true, async () => {
    await gate;
    return {};
  });
  const first = runner.tick(def);
  while (!runner.isTickRunning('r_reentrant')) {
    await new Promise((r) => setImmediate(r));
  }
  const second = await runner.tick(def);
  assert.equal(second.status, 'skipped_reentrant');
  release();
  const firstR = await first;
  assert.equal(firstR.status, 'ok');
});

test('long error message is truncated to 1024 chars in lastError', async () => {
  const big = 'x'.repeat(5000);
  const def = makeDef('r_trunc', true, async () => { throw new Error(big); });
  await runner.tick(def);
  const row = await models.Job.findOne({ where: { name: 'r_trunc' } });
  assert.ok((row?.lastError?.length ?? 0) <= 1024);
});

test('job run retention keeps the latest 100 rows per job', async () => {
  const now = new Date('2026-05-26T10:00:00Z').getTime();
  for (let i = 0; i < 105; i += 1) {
    await models.JobRun.create({
      jobName: 'r_retention',
      startedAt: new Date(now + i),
      finishedAt: new Date(now + i),
      status: 'success',
      durationMs: i,
      errorMessage: null,
    });
  }
  const def = makeDef('r_retention', true, async () => ({}));

  await runner.tick(def);

  const runs = await models.JobRun.findAll({
    where: { jobName: 'r_retention' },
    order: [['startedAt', 'ASC']],
  });
  assert.equal(runs.length, 100);
  assert.equal(runs[0].durationMs, 6);
});

test('daily job-run cleanup prunes all jobs to their latest 100 rows', async () => {
  const now = new Date('2026-05-26T10:00:00Z').getTime();
  for (const jobName of ['r_cleanup_a', 'r_cleanup_b']) {
    for (let i = 0; i < 101; i += 1) {
      await models.JobRun.create({
        jobName,
        startedAt: new Date(now + i),
        finishedAt: new Date(now + i),
        status: 'success',
        durationMs: i,
        errorMessage: null,
      });
    }
  }

  const summary = await runRetention.pruneAllJobRuns();

  assert.deepEqual(summary, { jobsScanned: 2, deleted: 2 });
  assert.equal(await models.JobRun.count({ where: { jobName: 'r_cleanup_a' } }), 100);
  assert.equal(await models.JobRun.count({ where: { jobName: 'r_cleanup_b' } }), 100);
});

test('failed tick enqueues one notification for each owner recipient', async () => {
  const owner = await models.User.create({
    email: 'owner@example.com',
    passwordHash: 'x',
    passwordSalt: 'x',
    passwordParams: 'x',
    displayName: 'Owner',
    globalRole: 'user',
    dob: null,
  });
  const def = makeDef('r_notify', true, async () => {
    throw new Error('notify boom');
  });

  const r = await runner.tick(def, { failureNotificationUserIds: [owner.id] });

  assert.equal(r.status, 'error');
  assert.ok(r.runId);
  const notifications = await models.Notification.findAll({ where: { userId: owner.id } });
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].type, 'job.failed');
  assert.equal(notifications[0].severity, 'critical');
  assert.ok(notifications[0].title.includes('r_notify'));
});
