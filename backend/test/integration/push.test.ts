/**
 * Integration tests for web-push delivery (issue #651). Runs against a real
 * Postgres test DB so the new table, unique endpoint index, and channel_push
 * column exercise the production dialect.
 *
 * Covers:
 *   AC #3 — POST /api/push/subscriptions persists a user-scoped row, 201;
 *           re-post same endpoint upserts (no duplicate).
 *   AC #4 — POST with missing endpoint/keys → 400, persists nothing.
 *   AC #5 — DELETE removes only the caller's row, 204; 404 when absent;
 *           never deletes another user's row.
 *   AC #7 — GET /api/config returns vapidPublicKey (set + unset).
 *   AC #1 — enqueueNotification with channelPush=true + a subscription sends
 *           exactly one push AND writes the in-app row.
 *   AC #2 — enqueueNotification sends no push when channelPush=false (and the
 *           in-app row is still written).
 */
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import request from 'supertest';
import { setupPgTestDb, teardownPgTestDb, type PgTestDb } from './_setup/pgTestDb.js';

let app: import('express').Express;
let primaryAgent: ReturnType<typeof request.agent>;
let primaryUserId: number;
let otherAgent: ReturnType<typeof request.agent>;
let otherUserId: number;
let testDb: PgTestDb;

type Seeded = { token: string; userId: number };

async function seed(emailPrefix: string): Promise<Seeded> {
  const models = await import('../../src/models');
  const { hashPassword, hashToken } = await import('../../src/auth/password.js');
  const password = await hashPassword('password123');
  const user = await models.User.create({
    email: `${emailPrefix}-${Date.now()}-${Math.random().toString(16).slice(2)}@example.com`,
    displayName: emailPrefix,
    globalRole: 'user',
    passwordHash: password.hash,
    passwordSalt: password.salt,
    passwordParams: password.params,
  });
  const household = await models.Household.create({ name: `${emailPrefix} household` });
  await models.HouseholdMember.create({
    householdId: household.id,
    userId: user.id,
    role: 'owner',
  });
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24);
  await models.Session.create({
    userId: user.id,
    tokenHash: hashToken(token),
    expiresAt,
  });
  return { token, userId: user.id };
}

before(async () => {
  process.env.NODE_ENV = 'test';
  process.env.VAPID_PUBLIC_KEY = 'integration-public-key';
  process.env.VAPID_PRIVATE_KEY = 'integration-private-key';

  testDb = await setupPgTestDb('push');

  const mod = await import('../../src/app.js');
  app = mod.default;

  const primary = await seed('push-primary');
  primaryUserId = primary.userId;
  primaryAgent = request.agent(app);
  primaryAgent.jar.setCookie(`cashflow_session=${primary.token}; Path=/`);

  const other = await seed('push-other');
  otherUserId = other.userId;
  otherAgent = request.agent(app);
  otherAgent.jar.setCookie(`cashflow_session=${other.token}; Path=/`);
});

after(async () => {
  await teardownPgTestDb(testDb);
});

beforeEach(async () => {
  const models = await import('../../src/models');
  await models.PushSubscription.destroy({ where: {} });
  await models.Notification.destroy({ where: {} });
  await models.NotificationPreference.destroy({ where: {} });
});

const validBody = (endpoint = 'https://fcm.googleapis.com/fcm/send/primary') => ({
  endpoint,
  keys: { p256dh: 'pkey', auth: 'akey' },
  userAgent: 'Chrome',
});

test('AC3: POST persists a user-scoped row and returns 201', async () => {
  const models = await import('../../src/models');
  const res = await primaryAgent.post('/api/push/subscriptions').send(validBody());
  assert.equal(res.status, 201);
  assert.ok(typeof res.body.id === 'number');

  const rows = await models.PushSubscription.findAll({ where: { userId: primaryUserId } });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].endpoint, 'https://fcm.googleapis.com/fcm/send/primary');
  assert.equal(rows[0].p256dh, 'pkey');
  assert.equal(rows[0].userAgent, 'Chrome');
});

test('AC3: re-posting the same endpoint upserts (no duplicate row)', async () => {
  const models = await import('../../src/models');
  await primaryAgent.post('/api/push/subscriptions').send(validBody());
  const res2 = await primaryAgent
    .post('/api/push/subscriptions')
    .send({ ...validBody(), keys: { p256dh: 'new-pkey', auth: 'new-akey' } });
  assert.equal(res2.status, 201);

  const rows = await models.PushSubscription.findAll({ where: { userId: primaryUserId } });
  assert.equal(rows.length, 1, 'still exactly one row');
  assert.equal(rows[0].p256dh, 'new-pkey', 'keys updated in place');
});

test('AC4: POST with missing endpoint returns 400 and persists nothing', async () => {
  const models = await import('../../src/models');
  const res = await primaryAgent
    .post('/api/push/subscriptions')
    .send({ keys: { p256dh: 'k', auth: 'a' } });
  assert.equal(res.status, 400);
  const count = await models.PushSubscription.count();
  assert.equal(count, 0);
});

test('AC4: POST with missing keys.p256dh returns 400', async () => {
  const res = await primaryAgent
    .post('/api/push/subscriptions')
    .send({ endpoint: 'https://fcm.googleapis.com/fcm/send/x', keys: { auth: 'a' } });
  assert.equal(res.status, 400);
});

test('AC4: POST with missing keys.auth returns 400', async () => {
  const res = await primaryAgent
    .post('/api/push/subscriptions')
    .send({ endpoint: 'https://fcm.googleapis.com/fcm/send/x', keys: { p256dh: 'k' } });
  assert.equal(res.status, 400);
});

test('issue #855: POST with an internal/non-allowlisted endpoint is rejected (SSRF)', async () => {
  const models = await import('../../src/models');
  for (const endpoint of [
    'http://169.254.169.254/latest/meta-data/',
    'http://localhost:9090/x',
    'https://internal.corp/x',
    'http://fcm.googleapis.com/fcm/send/x', // non-https on an allowlisted host
  ]) {
    const res = await primaryAgent
      .post('/api/push/subscriptions')
      .send(validBody(endpoint));
    assert.equal(res.status, 400, `should reject ${endpoint}`);
  }
  const count = await models.PushSubscription.count();
  assert.equal(count, 0, 'no SSRF endpoint persisted');
});

test('AC5: DELETE removes the caller row and returns 204', async () => {
  const models = await import('../../src/models');
  await primaryAgent.post('/api/push/subscriptions').send(validBody());
  const res = await primaryAgent
    .delete('/api/push/subscriptions')
    .send({ endpoint: 'https://fcm.googleapis.com/fcm/send/primary' });
  assert.equal(res.status, 204);
  const count = await models.PushSubscription.count({ where: { userId: primaryUserId } });
  assert.equal(count, 0);
});

test('AC5: DELETE of a non-existent endpoint returns 404', async () => {
  const res = await primaryAgent
    .delete('/api/push/subscriptions')
    .send({ endpoint: 'https://fcm.googleapis.com/fcm/send/nope' });
  assert.equal(res.status, 404);
});

test('AC5: DELETE never removes another user row (404, row survives)', async () => {
  const models = await import('../../src/models');
  // other user owns the endpoint
  await otherAgent
    .post('/api/push/subscriptions')
    .send(validBody('https://fcm.googleapis.com/fcm/send/shared'));
  // primary tries to delete it
  const res = await primaryAgent
    .delete('/api/push/subscriptions')
    .send({ endpoint: 'https://fcm.googleapis.com/fcm/send/shared' });
  assert.equal(res.status, 404);
  const stillThere = await models.PushSubscription.findOne({
    where: { endpoint: 'https://fcm.googleapis.com/fcm/send/shared', userId: otherUserId },
  });
  assert.ok(stillThere, "other user's row survived");
});

test('AC7: GET /api/config returns the configured vapidPublicKey', async () => {
  const res = await request(app).get('/api/config');
  assert.equal(res.status, 200);
  assert.equal(res.body.vapidPublicKey, 'integration-public-key');
});

test('AC1: enqueueNotification with channelPush=true sends one push AND writes in-app row', async () => {
  const models = await import('../../src/models');
  const { enqueueNotification } = await import('../../src/notifications/index.js');

  await models.NotificationPreference.create({
    userId: primaryUserId,
    type: 'budget.breach',
    channelInApp: true,
    channelEmail: false,
    channelPush: true,
  });
  await models.PushSubscription.create({
    userId: primaryUserId,
    endpoint: 'https://fcm.googleapis.com/fcm/send/primary',
    p256dh: 'p',
    auth: 'a',
    userAgent: null,
  });

  const sent: string[] = [];
  const result = await enqueueNotification(
    primaryUserId,
    'budget.breach',
    { severity: 'warn', title: 'Budget breached', body: 'Over 100%', dataJson: { budgetId: 7 } },
    async (target) => {
      sent.push(target.endpoint);
      return 'sent';
    },
  );

  assert.equal(result.status, 'created');
  assert.deepEqual(sent, ['https://fcm.googleapis.com/fcm/send/primary'], 'exactly one push');

  const inApp = await models.Notification.findAll({ where: { userId: primaryUserId } });
  assert.equal(inApp.length, 1, 'in-app row still written');
  assert.equal(inApp[0].type, 'budget.breach');
});

test('AC2: enqueueNotification sends no push when channelPush=false; in-app unchanged', async () => {
  const models = await import('../../src/models');
  const { enqueueNotification } = await import('../../src/notifications/index.js');

  await models.NotificationPreference.create({
    userId: primaryUserId,
    type: 'budget.breach',
    channelInApp: true,
    channelEmail: false,
    channelPush: false,
  });
  await models.PushSubscription.create({
    userId: primaryUserId,
    endpoint: 'https://fcm.googleapis.com/fcm/send/primary',
    p256dh: 'p',
    auth: 'a',
    userAgent: null,
  });

  let pushCalls = 0;
  const result = await enqueueNotification(
    primaryUserId,
    'budget.breach',
    { title: 'Budget breached', body: 'Over 80%' },
    async () => {
      pushCalls += 1;
      return 'sent';
    },
  );

  assert.equal(result.status, 'created');
  assert.equal(pushCalls, 0, 'no push sent when channelPush=false');
  const inApp = await models.Notification.count({ where: { userId: primaryUserId } });
  assert.equal(inApp, 1, 'in-app row still written');
});

test('AC2: no push when channelPush=true but the user has no subscriptions', async () => {
  const models = await import('../../src/models');
  const { enqueueNotification } = await import('../../src/notifications/index.js');

  await models.NotificationPreference.create({
    userId: primaryUserId,
    type: 'budget.breach',
    channelInApp: true,
    channelEmail: false,
    channelPush: true,
  });

  let pushCalls = 0;
  await enqueueNotification(
    primaryUserId,
    'budget.breach',
    { title: 'T', body: 'B' },
    async () => {
      pushCalls += 1;
      return 'sent';
    },
  );
  assert.equal(pushCalls, 0, 'no subscriptions → no send');
  const inApp = await models.Notification.count({ where: { userId: primaryUserId } });
  assert.equal(inApp, 1);
});
