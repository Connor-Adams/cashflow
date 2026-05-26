import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';

let models: typeof import('../../src/models');
let runner: typeof import('../../src/jobs/runner');
let types: typeof import('../../src/jobs/types');

function makeDef(
  name: string,
  enabledDefault: boolean,
  handler: import('../../src/jobs/types').JobHandler,
): import('../../src/jobs/types').JobDefinition {
  return { name, cronDefault: '* * * * *', enabledDefault, handler };
}

before(async () => {
  models = await import('../../src/models');
  await models.sequelize.sync();
  runner = await import('../../src/jobs/runner');
  types = await import('../../src/jobs/types');
  void types;
});

after(async () => { await models.sequelize.close(); });

beforeEach(async () => {
  await models.Job.destroy({ where: {}, truncate: true });
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
  const row = await models.Job.findOne({ where: { name: 'r_ok' } });
  assert.ok(row);
  assert.equal(row.lastStatus, 'ok');
  assert.ok((row.lastDurationMs ?? -1) >= 0);
  assert.ok(row.lastResultJson?.includes('"processed":7'));
});

test('handler throw produces error status and truncated error', async () => {
  const def = makeDef('r_err', true, async () => {
    throw new Error('kaboom');
  });
  const r = await runner.tick(def);
  assert.equal(r.status, 'error');
  const row = await models.Job.findOne({ where: { name: 'r_err' } });
  assert.ok(row);
  assert.equal(row.lastStatus, 'error');
  assert.ok(row.lastError?.includes('kaboom'));
});

test('concurrent ticks: second sees skipped_reentrant in-process', async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((res) => { release = res; });
  const def = makeDef('r_reentrant', true, async () => {
    await gate;
    return {};
  });
  const first = runner.tick(def);
  // Give first a moment to set the guard
  await new Promise((r) => setImmediate(r));
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
