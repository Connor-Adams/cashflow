// backend/test/requestContext.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { withContext, currentContext } from './requestContext';

test('withContext exposes its ctx via currentContext inside fn', () => {
  withContext({ requestId: 'r1', userId: 'u1' }, () => {
    assert.deepEqual(currentContext(), { requestId: 'r1', userId: 'u1' });
  });
});

test('nested withContext merges, inner overrides on key collision', () => {
  withContext({ requestId: 'outer', userId: 'u1' }, () => {
    withContext({ requestId: 'inner', householdId: 'h1' }, () => {
      assert.deepEqual(currentContext(), {
        requestId: 'inner',
        userId: 'u1',
        householdId: 'h1',
      });
    });
    // After inner returns, the outer ctx is restored.
    assert.deepEqual(currentContext(), { requestId: 'outer', userId: 'u1' });
  });
});

test('currentContext is undefined outside any withContext', () => {
  assert.equal(currentContext(), undefined);
});

test('ctx propagates across awaits (async continuation)', async () => {
  await withContext({ requestId: 'r1' }, async () => {
    await sleep(1);
    assert.deepEqual(currentContext(), { requestId: 'r1' });
  });
});
