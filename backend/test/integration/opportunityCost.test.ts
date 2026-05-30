/**
 * Integration tests for POST /api/opportunity-cost/calculate (issue #252).
 *
 * The endpoint is a pure calculator: it requires auth but performs NO
 * persistence, so calculating never alters any transaction totals. These
 * tests prove the route is mounted under auth, validates its body, and
 * returns the future-value breakdown.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import request from 'supertest';
import { setupPgTestDb, teardownPgTestDb, type PgTestDb } from './_setup/pgTestDb.js';

let app: import('express').Express;
let agent: ReturnType<typeof request.agent>;
let testDb: PgTestDb;

async function seedUser(emailPrefix: string): Promise<string> {
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
  return token;
}

before(async () => {
  process.env.NODE_ENV = 'test';
  testDb = await setupPgTestDb('oppcost');

  const mod = await import('../../src/app.js');
  app = mod.default;

  // Bootstrap a superadmin so the very first registration succeeds.
  const bootstrap = request.agent(app);
  const register = await bootstrap.post('/api/auth/register').send({
    email: 'superadmin@example.com',
    displayName: 'Super Admin',
    password: 'password123',
  });
  assert.equal(register.status, 201);

  const token = await seedUser('Calc');
  agent = request.agent(app);
  agent.jar.setCookie(`cashflow_session=${token}; Path=/`);
});

after(async () => {
  await teardownPgTestDb(testDb);
});

test('rejects an unauthenticated request', async () => {
  const res = await request(app)
    .post('/api/opportunity-cost/calculate')
    .send({ mode: 'one-time', amount: 1000, horizonYears: 10, annualReturnRate: 0.07 });
  assert.equal(res.status, 401);
});

test('calculates a one-time opportunity cost', async () => {
  const res = await agent.post('/api/opportunity-cost/calculate').send({
    mode: 'one-time',
    amount: 1000,
    horizonYears: 10,
    annualReturnRate: 0.07,
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.mode, 'one-time');
  assert.equal(res.body.totalContributions, 1000);
  // 1000 * 1.07^10 = 1967.15 (cent-rounded)
  assert.equal(res.body.futureValue, 1967.15);
  assert.equal(res.body.gain, 967.15);
  assert.ok(Array.isArray(res.body.assumptions));
  assert.ok(res.body.assumptions.length >= 1);
});

test('calculates a recurring opportunity cost', async () => {
  const res = await agent.post('/api/opportunity-cost/calculate').send({
    mode: 'recurring',
    amount: 200,
    cadence: 'monthly',
    horizonYears: 10,
    annualReturnRate: 0.06,
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.mode, 'recurring');
  assert.equal(res.body.cadence, 'monthly');
  assert.equal(res.body.totalContributions, 24000);
  assert.ok(res.body.futureValue > 24000, 'future value exceeds contributions');
  assert.equal(res.body.monthlyEquivalent, 200);
});

test('rejects an invalid mode', async () => {
  const res = await agent.post('/api/opportunity-cost/calculate').send({
    mode: 'nope',
    amount: 1000,
    horizonYears: 10,
    annualReturnRate: 0.07,
  });
  assert.equal(res.status, 400);
  assert.ok(typeof res.body.error === 'string');
});

test('rejects a non-positive amount', async () => {
  const res = await agent.post('/api/opportunity-cost/calculate').send({
    mode: 'one-time',
    amount: -5,
    horizonYears: 10,
    annualReturnRate: 0.07,
  });
  assert.equal(res.status, 400);
});

test('rejects a missing cadence for recurring', async () => {
  const res = await agent.post('/api/opportunity-cost/calculate').send({
    mode: 'recurring',
    amount: 200,
    horizonYears: 10,
    annualReturnRate: 0.06,
  });
  assert.equal(res.status, 400);
});
