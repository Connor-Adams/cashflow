import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';

let pgLock: typeof import('./pgLock');
let models: typeof import('../models');

before(async () => {
  models = await import('../models');
  await models.sequelize.sync();
  pgLock = await import('./pgLock');
});

after(async () => { await models.sequelize.close(); });

test('withAdvisoryLock on sqlite is no-op and runs fn', async () => {
  let ran = false;
  const r = await pgLock.withAdvisoryLock('test_lock_a', async () => {
    ran = true;
    return 42;
  });
  assert.equal(ran, true);
  assert.deepEqual(r, { acquired: true, value: 42 });
});

test('withAdvisoryLock fn errors propagate', async () => {
  await assert.rejects(
    pgLock.withAdvisoryLock('test_lock_b', async () => {
      throw new Error('boom');
    }),
    /boom/,
  );
});

test('hashName produces stable bigint for the same string', async () => {
  const a = pgLock.hashJobNameForTest('forward_income');
  const b = pgLock.hashJobNameForTest('forward_income');
  const c = pgLock.hashJobNameForTest('daily_snapshot');
  assert.equal(a, b);
  assert.notEqual(a, c);
});
