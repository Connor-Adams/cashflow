/**
 * Unit tests for the web-push fan-out + dead-endpoint pruning (issue #651,
 * AC #1/#2/#6 logic). Runs against the per-process SQLite unit DB with an
 * injected sender, so no real push service or `web-push` global VAPID state is
 * needed. VAPID env is set so `isPushConfigured()` is true for the
 * configured-path tests.
 */
import { before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';

// Configure VAPID BEFORE importing the module (env is read at module load for
// the `isPushConfigured` gate via `* as env`, which reads live each call).
process.env.VAPID_PUBLIC_KEY = 'test-public-key';
process.env.VAPID_PRIVATE_KEY = 'test-private-key';

let models: typeof import('../src/models');
let fanOutWebPush: typeof import('../src/notifications/webPush').fanOutWebPush;
let userId: number;

before(async () => {
  models = await import('../src/models');
  ({ fanOutWebPush } = await import('../src/notifications/webPush'));
  await models.sequelize.sync({ force: true });
});

beforeEach(async () => {
  await models.PushSubscription.destroy({ where: {} });
  await models.User.destroy({ where: {} });
  const user = await models.User.create({
    email: `push-${Date.now()}-${Math.random().toString(16).slice(2)}@example.com`,
    displayName: 'Push User',
    globalRole: 'user',
    passwordHash: 'x',
    passwordSalt: 'x',
    passwordParams: '{}',
  });
  userId = user.id;
});

async function addSub(endpoint: string) {
  return models.PushSubscription.create({
    userId,
    endpoint,
    p256dh: 'p',
    auth: 'a',
    userAgent: null,
  });
}

test('AC1: fans out to every active subscription the user owns', async () => {
  await addSub('https://push.example/a');
  await addSub('https://push.example/b');
  const seen: string[] = [];
  const result = await fanOutWebPush(
    userId,
    { title: 'T', body: 'B', severity: 'warn', dataJson: { budgetId: 1 } },
    async (target) => {
      seen.push(target.endpoint);
      return 'sent';
    },
  );
  assert.equal(result.sent, 2);
  assert.equal(result.pruned, 0);
  assert.deepEqual(seen.sort(), ['https://push.example/a', 'https://push.example/b']);
});

test('AC2: no subscriptions → no send, zeroed counts', async () => {
  let called = 0;
  const result = await fanOutWebPush(
    userId,
    { title: 'T', body: 'B' },
    async () => {
      called += 1;
      return 'sent';
    },
  );
  assert.equal(called, 0);
  assert.deepEqual(result, { sent: 0, pruned: 0, failed: 0 });
});

test('AC6: a 410/gone endpoint is pruned; the rest still receive the push', async () => {
  await addSub('https://push.example/dead');
  await addSub('https://push.example/live');
  const result = await fanOutWebPush(
    userId,
    { title: 'T', body: 'B' },
    async (target) => (target.endpoint.endsWith('/dead') ? 'gone' : 'sent'),
  );
  assert.equal(result.sent, 1, 'live endpoint still delivered');
  assert.equal(result.pruned, 1, 'dead endpoint pruned');

  const remaining = await models.PushSubscription.findAll({ where: { userId } });
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].endpoint, 'https://push.example/live');
});

test('a transient failure keeps the row (not pruned)', async () => {
  await addSub('https://push.example/flaky');
  const result = await fanOutWebPush(
    userId,
    { title: 'T', body: 'B' },
    async () => 'failed',
  );
  assert.equal(result.failed, 1);
  assert.equal(result.pruned, 0);
  const remaining = await models.PushSubscription.count({ where: { userId } });
  assert.equal(remaining, 1, 'failed endpoint NOT pruned');
});

test('payload is serialized with title/body/severity/dataJson', async () => {
  await addSub('https://push.example/p');
  let payloadJson = '';
  await fanOutWebPush(
    userId,
    { title: 'Hello', body: 'World', severity: 'critical', dataJson: { link: '/budgets' } },
    async (_t, json) => {
      payloadJson = json;
      return 'sent';
    },
  );
  const parsed = JSON.parse(payloadJson);
  assert.equal(parsed.title, 'Hello');
  assert.equal(parsed.body, 'World');
  assert.equal(parsed.severity, 'critical');
  assert.deepEqual(parsed.dataJson, { link: '/budgets' });
});
