/**
 * Integration tests for /api/settings/cashflow (issue #199). Covers the
 * per-user GET (returns defaults when no row exists) and PATCH (creates
 * row on first call, then updates fields on later calls). Cross-user
 * isolation is exercised via two separate sessions.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import request from 'supertest';
import { testAgent } from './_setup/testServer.js';
import { setupPgTestDb, teardownPgTestDb, type PgTestDb } from './_setup/pgTestDb.js';

let app: import('express').Express;
let primaryAgent: ReturnType<typeof request.agent>;
let otherAgent: ReturnType<typeof request.agent>;
let testDb: PgTestDb;

type Seeded = {
  token: string;
  householdId: number;
  userId: number;
};

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
  return { token, householdId: household.id, userId: user.id };
}

before(async () => {
  process.env.NODE_ENV = 'test';

  testDb = await setupPgTestDb('cashflow_settings');

  const mod = await import('../../src/app.js');
  app = mod.default;

  const bootstrap = testAgent(app);
  const register = await bootstrap.post('/api/auth/register').send({
    email: 'superadmin@example.com',
    displayName: 'Super Admin',
    password: 'password123',
  });
  assert.equal(register.status, 201);

  const primary = await seed('Primary');
  primaryAgent = testAgent(app);
  primaryAgent.jar.setCookie(`cashflow_session=${primary.token}; Path=/`);

  const other = await seed('Other');
  otherAgent = testAgent(app);
  otherAgent.jar.setCookie(`cashflow_session=${other.token}; Path=/`);
});

after(async () => {
  await teardownPgTestDb(testDb);
});

test('GET /api/settings/cashflow returns defaults when no row exists', async () => {
  const res = await primaryAgent.get('/api/settings/cashflow');
  assert.equal(res.status, 200);
  assert.equal(res.body.minimumCashBuffer, '0.0000');
  assert.equal(res.body.safeToSpendWindowDays, 14);
  assert.equal(res.body.includeCreditCardBalance, true);
  assert.equal(res.body.includeGoalContributions, true);
  // #375 — exclude_non_partner_inflows defaults to true so the partner
  // fairness dashboard hides side-gig / friend-repayment inflows out of
  // the box.
  assert.equal(res.body.excludeNonPartnerInflows, true);
});

test('PATCH /api/settings/cashflow creates row on first call', async () => {
  const res = await primaryAgent.patch('/api/settings/cashflow').send({
    minimumCashBuffer: 500,
    safeToSpendWindowDays: 30,
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.minimumCashBuffer, '500.0000');
  assert.equal(res.body.safeToSpendWindowDays, 30);
  // Untouched fields keep their defaults.
  assert.equal(res.body.includeCreditCardBalance, true);
  assert.equal(res.body.includeGoalContributions, true);
});

test('GET /api/settings/cashflow returns persisted row after PATCH', async () => {
  const res = await primaryAgent.get('/api/settings/cashflow');
  assert.equal(res.status, 200);
  assert.equal(res.body.minimumCashBuffer, '500.0000');
  assert.equal(res.body.safeToSpendWindowDays, 30);
});

test('PATCH updates a subset, leaves other fields alone', async () => {
  const res = await primaryAgent.patch('/api/settings/cashflow').send({
    includeCreditCardBalance: false,
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.minimumCashBuffer, '500.0000');
  assert.equal(res.body.safeToSpendWindowDays, 30);
  assert.equal(res.body.includeCreditCardBalance, false);
  assert.equal(res.body.includeGoalContributions, true);
});

test('PATCH rejects negative minimumCashBuffer', async () => {
  const res = await primaryAgent.patch('/api/settings/cashflow').send({
    minimumCashBuffer: -10,
  });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /non-negative/);
});

test('PATCH rejects out-of-range safeToSpendWindowDays', async () => {
  const big = await primaryAgent.patch('/api/settings/cashflow').send({
    safeToSpendWindowDays: 1000,
  });
  assert.equal(big.status, 400);
  const small = await primaryAgent.patch('/api/settings/cashflow').send({
    safeToSpendWindowDays: 0,
  });
  assert.equal(small.status, 400);
});

test('cross-user isolation: other user sees defaults, not primary row', async () => {
  const res = await otherAgent.get('/api/settings/cashflow');
  assert.equal(res.status, 200);
  // Defaults still — primary's PATCH never touched this user's row.
  assert.equal(res.body.minimumCashBuffer, '0.0000');
  assert.equal(res.body.safeToSpendWindowDays, 14);
  assert.equal(res.body.includeCreditCardBalance, true);
});

test('cross-user isolation: other user PATCH does not bleed into primary', async () => {
  const r1 = await otherAgent.patch('/api/settings/cashflow').send({
    minimumCashBuffer: 999,
  });
  assert.equal(r1.status, 200);
  assert.equal(r1.body.minimumCashBuffer, '999.0000');

  // Primary still sees their own (500).
  const r2 = await primaryAgent.get('/api/settings/cashflow');
  assert.equal(r2.body.minimumCashBuffer, '500.0000');
});

test('unauthenticated request is rejected', async () => {
  const fresh = testAgent(app);
  const res = await fresh.get('/api/settings/cashflow');
  assert.equal(res.status, 401);
});

test('PATCH /api/settings/cashflow accepts excludeNonPartnerInflows=false', async () => {
  const res = await primaryAgent.patch('/api/settings/cashflow').send({
    excludeNonPartnerInflows: false,
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.excludeNonPartnerInflows, false);
  // Other fields untouched.
  assert.equal(res.body.includeGoalContributions, true);
});

test('PATCH /api/settings/cashflow rejects non-boolean excludeNonPartnerInflows', async () => {
  const res = await primaryAgent.patch('/api/settings/cashflow').send({
    excludeNonPartnerInflows: 'sometimes',
  });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /excludeNonPartnerInflows must be boolean/);
});

test('PATCH /api/settings/cashflow coerces string boolean inputs', async () => {
  const res = await primaryAgent.patch('/api/settings/cashflow').send({
    excludeNonPartnerInflows: 'true',
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.excludeNonPartnerInflows, true);
});
