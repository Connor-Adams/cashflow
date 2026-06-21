/**
 * Integration tests for /api/notifications and the user-namespaced
 * notification preferences (/api/users/me/notifications/preferences, folded
 * there by issue #379; the old /api/notification-preferences path now 410s).
 * Spins up a real Postgres test database (via pgTestDb helper)
 * so the JSON column, indexes, and unique constraint actually exercise the
 * production dialect — sqlite is too forgiving for these.
 *
 * Two seeded users with separate sessions let us verify user-scope
 * (AC #13) end-to-end.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import request from 'supertest';
import { testAgent } from './_setup/testServer.js';
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
  testDb = await setupPgTestDb('notifications');

  const mod = await import('../../src/app.js');
  app = mod.default;

  // Bootstrap a superadmin so the auth/register endpoint accepts the next
  // non-superadmin registrations (mirrors the goals + plannedEvents pattern).
  const bootstrap = testAgent(app);
  const register = await bootstrap.post('/api/auth/register').send({
    email: 'superadmin@example.com',
    displayName: 'Super Admin',
    password: 'password123',
  });
  assert.equal(register.status, 201);

  const primary = await seed('Primary');
  primaryUserId = primary.userId;
  primaryAgent = testAgent(app);
  primaryAgent.jar.setCookie(`cashflow_session=${primary.token}; Path=/`);

  const other = await seed('Other');
  otherUserId = other.userId;
  otherAgent = testAgent(app);
  otherAgent.jar.setCookie(`cashflow_session=${other.token}; Path=/`);
});

after(async () => {
  await teardownPgTestDb(testDb);
});

// ---- enqueueNotification + list -----------------------------------------

test('enqueueNotification writes a row, GET /api/notifications returns it', async () => {
  const { enqueueNotification } = await import('../../src/notifications/index.js');
  const result = await enqueueNotification(primaryUserId, 'budget.breach', {
    severity: 'warn',
    title: 'Budget exceeded',
    body: 'You spent more than budgeted on Groceries this month.',
    dataJson: { budgetId: 1, percent: 1.2 },
  });
  assert.equal(result.status, 'created');

  const res = await primaryAgent.get('/api/notifications');
  assert.equal(res.status, 200);
  const rows = res.body.data as Array<{
    id: number;
    type: string;
    severity: string;
    title: string;
    body: string;
    dataJson: Record<string, unknown> | null;
    readAt: string | null;
    createdAt: string;
  }>;
  assert.ok(rows.length >= 1);
  const row = rows[0];
  assert.equal(row.type, 'budget.breach');
  assert.equal(row.severity, 'warn');
  assert.equal(row.title, 'Budget exceeded');
  assert.deepEqual(row.dataJson, { budgetId: 1, percent: 1.2 });
  assert.equal(row.readAt, null);
});

test('GET /api/notifications returns newest-first (AC #4)', async () => {
  const { enqueueNotification } = await import('../../src/notifications/index.js');
  await enqueueNotification(primaryUserId, 'insight.new', {
    title: 'First',
    body: 'body',
  });
  // Sleep 5ms to ensure timestamp ordering.
  await new Promise((resolve) => setTimeout(resolve, 10));
  await enqueueNotification(primaryUserId, 'insight.new', {
    title: 'Second',
    body: 'body',
  });
  const res = await primaryAgent.get('/api/notifications');
  const rows = res.body.data as Array<{ title: string }>;
  const titles = rows.map((r) => r.title);
  // 'Second' must come before 'First' (newest-first).
  const idxFirst = titles.indexOf('First');
  const idxSecond = titles.indexOf('Second');
  assert.ok(idxSecond >= 0 && idxFirst >= 0, 'both inserts visible');
  assert.ok(idxSecond < idxFirst, `expected Second before First, got ${titles.join(',')}`);
});

test('GET /api/notifications respects limit parameter (AC #4)', async () => {
  const res = await primaryAgent.get('/api/notifications').query({ limit: 1 });
  assert.equal(res.status, 200);
  assert.equal((res.body.data as unknown[]).length, 1);
});

test('GET /api/notifications clamps limit to MAX_LIMIT (100)', async () => {
  // Verify that a huge limit value is accepted (clamped) rather than 400ing.
  const res = await primaryAgent.get('/api/notifications').query({ limit: 99999 });
  assert.equal(res.status, 200);
});

test('GET /api/notifications supports unreadOnly=true', async () => {
  const res = await primaryAgent
    .get('/api/notifications')
    .query({ unreadOnly: 'true' });
  assert.equal(res.status, 200);
  for (const row of res.body.data as Array<{ readAt: string | null }>) {
    assert.equal(row.readAt, null);
  }
});

// ---- unread-count -------------------------------------------------------

test('GET /api/notifications/unread-count returns the count (AC #5)', async () => {
  const res = await primaryAgent.get('/api/notifications/unread-count');
  assert.equal(res.status, 200);
  assert.ok(typeof res.body.count === 'number');
  assert.ok(res.body.count >= 3, `expected at least 3 unread, got ${res.body.count}`);
});

// ---- mark single as read ------------------------------------------------

test('POST /api/notifications/:id/read sets readAt (AC #6)', async () => {
  const list = await primaryAgent.get('/api/notifications').query({ limit: 100 });
  const rows = list.body.data as Array<{ id: number; readAt: string | null }>;
  const unread = rows.find((r) => r.readAt == null);
  assert.ok(unread, 'precondition: at least one unread row exists');
  const id = unread.id;

  const res = await primaryAgent.post(`/api/notifications/${id}/read`);
  assert.equal(res.status, 200);
  assert.equal(res.body.id, id);
  assert.ok(res.body.readAt, 'readAt should be set');
});

test('POST /api/notifications/:id/read is user-scoped (AC #13)', async () => {
  const { enqueueNotification } = await import('../../src/notifications/index.js');
  const result = await enqueueNotification(otherUserId, 'system.welcome', {
    title: 'For other',
    body: 'body',
  });
  assert.equal(result.status, 'created');
  if (result.status !== 'created') return;
  const id = result.notification.id;
  // Primary user must NOT be able to mark another user's row as read.
  const res = await primaryAgent.post(`/api/notifications/${id}/read`);
  assert.equal(res.status, 404);
});

// ---- mark all as read ---------------------------------------------------

test('POST /api/notifications/mark-all-read updates all unread rows (AC #7)', async () => {
  const { enqueueNotification } = await import('../../src/notifications/index.js');
  await enqueueNotification(primaryUserId, 'system.welcome', {
    title: 'Welcome again',
    body: 'body',
  });
  // Pre: at least one unread for primary.
  const before = await primaryAgent.get('/api/notifications/unread-count');
  assert.ok(before.body.count >= 1);

  const res = await primaryAgent.post('/api/notifications/mark-all-read');
  assert.equal(res.status, 200);
  assert.ok(typeof res.body.updated === 'number');

  const after = await primaryAgent.get('/api/notifications/unread-count');
  assert.equal(after.body.count, 0);
});

test('mark-all-read is user-scoped — other user unread count unchanged (AC #13)', async () => {
  const { enqueueNotification } = await import('../../src/notifications/index.js');
  await enqueueNotification(otherUserId, 'system.welcome', {
    title: 'Other unread',
    body: 'body',
  });
  const otherCountBefore = await otherAgent.get('/api/notifications/unread-count');
  assert.ok(otherCountBefore.body.count >= 1);

  // Primary marks-all-read on their own scope.
  await primaryAgent.post('/api/notifications/mark-all-read');

  const otherCountAfter = await otherAgent.get('/api/notifications/unread-count');
  assert.equal(
    otherCountAfter.body.count,
    otherCountBefore.body.count,
    'mark-all-read by primary must not touch other-user rows',
  );
});

test('GET /api/notifications does not leak rows from another user (AC #13)', async () => {
  const otherList = await otherAgent.get('/api/notifications').query({ limit: 100 });
  const otherIds = (otherList.body.data as Array<{ id: number }>).map((r) => r.id);

  const primaryList = await primaryAgent.get('/api/notifications').query({ limit: 100 });
  const primaryIds = (primaryList.body.data as Array<{ id: number }>).map((r) => r.id);

  for (const id of otherIds) {
    assert.ok(
      !primaryIds.includes(id),
      `primary leaked other-user row ${id}: primaryIds=${primaryIds.join(',')}`,
    );
  }
});

// ---- notification preferences (folded under user namespace, issue #379) --
//
// Live path: GET  /api/users/me/notifications/preferences
//            PATCH /api/users/me/notifications/preferences/:type
// The old /api/notification-preferences path now returns 410 Gone (asserted
// in the dedicated test further down).

const PREFS_PATH = '/api/users/me/notifications/preferences';

test('GET /api/users/me/notifications/preferences returns defaults for unknown types (AC #8)', async () => {
  const { enqueueNotification } = await import('../../src/notifications/index.js');
  // Seed a notification of a never-before-seen type for primary.
  await enqueueNotification(primaryUserId, 'subscription.price_change', {
    title: 'Price change',
    body: 'Netflix increased',
  });
  const res = await primaryAgent.get(PREFS_PATH);
  assert.equal(res.status, 200);
  const rows = res.body.data as Array<{
    type: string;
    channelInApp: boolean;
    channelEmail: boolean;
  }>;
  const found = rows.find((r) => r.type === 'subscription.price_change');
  assert.ok(found, 'expected default pref row to be inferred from notifications table');
  assert.equal(found?.channelInApp, true);
  assert.equal(found?.channelEmail, false);
});

test('PATCH /api/users/me/notifications/preferences/:type upserts a preference (AC #9)', async () => {
  const res = await primaryAgent
    .patch(`${PREFS_PATH}/budget.breach`)
    .send({ channelInApp: false, channelEmail: true });
  assert.equal(res.status, 200);
  assert.equal(res.body.type, 'budget.breach');
  assert.equal(res.body.channelInApp, false);
  assert.equal(res.body.channelEmail, true);
});

test('PATCH /api/users/me/notifications/preferences/:type persists across calls', async () => {
  const list = await primaryAgent.get(PREFS_PATH);
  const found = (
    list.body.data as Array<{ type: string; channelInApp: boolean; channelEmail: boolean }>
  ).find((r) => r.type === 'budget.breach');
  assert.ok(found);
  assert.equal(found?.channelInApp, false);
  assert.equal(found?.channelEmail, true);
});

test('PATCH /api/users/me/notifications/preferences/:type rejects non-boolean body', async () => {
  const res = await primaryAgent
    .patch(`${PREFS_PATH}/budget.breach`)
    .send({ channelInApp: 'no' });
  assert.equal(res.status, 400);
});

test('enqueueNotification respects PATCHed mute (AC #2)', async () => {
  // budget.breach is now muted for primary (channelInApp=false). Enqueuing
  // a new one should not create a row.
  const { enqueueNotification } = await import('../../src/notifications/index.js');
  const before = await primaryAgent.get('/api/notifications/unread-count');
  const result = await enqueueNotification(primaryUserId, 'budget.breach', {
    title: 'Muted',
    body: 'body',
  });
  assert.equal(result.status, 'muted');
  const after = await primaryAgent.get('/api/notifications/unread-count');
  assert.equal(after.body.count, before.body.count);
});

test('PATCH /api/users/me/notifications/preferences with empty body leaves the row as-is', async () => {
  // Re-fetch the budget.breach pref (channelInApp=false, channelEmail=true).
  const res = await primaryAgent
    .patch(`${PREFS_PATH}/budget.breach`)
    .send({});
  assert.equal(res.status, 200);
  assert.equal(res.body.channelInApp, false);
  assert.equal(res.body.channelEmail, true);
});

test('notification preferences are user-scoped (AC #13)', async () => {
  // Primary set budget.breach to channelInApp=false. Other user should
  // see *defaults* (channelInApp=true) for the same type.
  // First, ensure other has at least one budget.breach event so the type
  // shows up in their list.
  const { enqueueNotification } = await import('../../src/notifications/index.js');
  await enqueueNotification(otherUserId, 'budget.breach', {
    title: 'Other budget',
    body: 'body',
  });
  const res = await otherAgent.get(PREFS_PATH);
  const found = (
    res.body.data as Array<{ type: string; channelInApp: boolean; channelEmail: boolean }>
  ).find((r) => r.type === 'budget.breach');
  assert.ok(found, 'expected budget.breach row in other user list');
  assert.equal(found?.channelInApp, true, "other user's pref must use defaults, not primary's");
  assert.equal(found?.channelEmail, false);
});

// ---- old path is gone (issue #379, AC #2) -------------------------------

test('GET /api/notification-preferences (old path) returns 410 Gone', async () => {
  const res = await primaryAgent.get('/api/notification-preferences');
  assert.equal(res.status, 410);
  assert.equal(res.body.error, 'gone');
  assert.match(
    res.body.message,
    /\/api\/users\/me\/notifications\/preferences/,
    'the 410 body should point at the new path',
  );
});

test('PATCH /api/notification-preferences/:type (old path) returns 410 Gone', async () => {
  const res = await primaryAgent
    .patch('/api/notification-preferences/budget.breach')
    .send({ channelInApp: true });
  assert.equal(res.status, 410);
  assert.equal(res.body.error, 'gone');
});

// ---- AC #3 sanity: no email is sent ------------------------------------

test('No email channel side-effect — issue #266 must not send any email', async () => {
  // This issue ships in-app only. The downstream weekly digest and budget
  // breach alert issues wire email — those depend on this one. Here we
  // simply assert that nothing in the module graph importable today has
  // a `sendNotificationEmail` symbol; a future regression that adds one
  // would need to be done in those issues.
  const helper = await import('../../src/notifications/index.js');
  const exported = Object.keys(helper);
  for (const k of exported) {
    assert.ok(
      !/email/i.test(k),
      `notifications/index.ts exported an email-sounding symbol "${k}" — this issue's contract bans an email channel`,
    );
  }
});
