/**
 * Integration test for the admin notifications endpoint (issue #267).
 *
 * Covers:
 *   - Non-superadmin → 403.
 *   - Superadmin POST /api/admin/notifications/digest/run-now?userId=<id>
 *     returns ok=true and dispatches to runWeeklyDigest for that user only.
 *   - Missing userId → 400.
 *   - Unknown userId → 404.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import request from 'supertest';
import { setupPgTestDb, teardownPgTestDb, type PgTestDb } from './_setup/pgTestDb.js';

let app: import('express').Express;
let testDb: PgTestDb;
let superadminAgent: ReturnType<typeof request.agent>;
let userAgent: ReturnType<typeof request.agent>;
let targetUserId: number;

async function seedUser(opts: {
  emailPrefix: string;
  role: 'user' | 'superadmin';
}): Promise<{ token: string; userId: number }> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const models: any = await import('../../src/models');
  const { hashPassword, hashToken } = await import('../../src/auth/password.js');
  const password = await hashPassword('password123');
  const user = await models.User.create({
    email: `${opts.emailPrefix}-${Date.now()}-${Math.random().toString(16).slice(2)}@example.com`,
    displayName: opts.emailPrefix,
    globalRole: opts.role,
    passwordHash: password.hash,
    passwordSalt: password.salt,
    passwordParams: password.params,
  });
  const household = await models.Household.create({ name: `${opts.emailPrefix} household` });
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
  testDb = await setupPgTestDb('notif_admin');

  const mod = await import('../../src/app.js');
  app = mod.default;

  // Bootstrap a superadmin via the register endpoint (it auto-promotes the
  // first user to superadmin) so subsequent seed inserts proceed.
  const bootstrap = request.agent(app);
  const register = await bootstrap.post('/api/auth/register').send({
    email: 'super-admin@example.com',
    displayName: 'Super',
    password: 'password123',
  });
  assert.equal(register.status, 201);

  const sa = await seedUser({ emailPrefix: 'sa', role: 'superadmin' });
  superadminAgent = request.agent(app);
  superadminAgent.jar.setCookie(`cashflow_session=${sa.token}; Path=/`);

  const u = await seedUser({ emailPrefix: 'regular', role: 'user' });
  userAgent = request.agent(app);
  userAgent.jar.setCookie(`cashflow_session=${u.token}; Path=/`);
  targetUserId = u.userId;
});

after(async () => {
  await teardownPgTestDb(testDb);
});

test('POST /api/admin/notifications/digest/run-now — non-superadmin gets 403', async () => {
  const res = await userAgent
    .post('/api/admin/notifications/digest/run-now')
    .send({ userId: targetUserId });
  assert.equal(res.status, 403);
});

test('POST /api/admin/notifications/digest/run-now — missing userId → 400', async () => {
  const res = await superadminAgent
    .post('/api/admin/notifications/digest/run-now')
    .send({});
  assert.equal(res.status, 400);
});

test('POST /api/admin/notifications/digest/run-now — unknown userId → 404', async () => {
  const res = await superadminAgent
    .post('/api/admin/notifications/digest/run-now')
    .send({ userId: 999999 });
  assert.equal(res.status, 404);
});

test('POST /api/admin/notifications/digest/run-now — superadmin can run for a user', async () => {
  const res = await superadminAgent
    .post('/api/admin/notifications/digest/run-now')
    .query({ userId: targetUserId });
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.ok(res.body.result);
  // User has no history → skippedNoHistory should be 1.
  assert.equal(res.body.result.skippedNoHistory, 1);
});
