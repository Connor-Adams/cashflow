/**
 * Integration tests for /api/rules effectiveFrom / effectiveTo handling.
 * Run in isolation (`yarn test:integration`) so DATABASE_URL is set before
 * any Sequelize import.
 *
 * Bootstraps a superadmin (first-registered-user shortcut), then seeds a
 * regular household whose session cookie drives the request agent.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import request from 'supertest';
import { setupPgTestDb, teardownPgTestDb, type PgTestDb } from './_setup/pgTestDb.js';

let app: import('express').Express;
let agent: ReturnType<typeof request.agent>;
let testDb: PgTestDb;

before(async () => {
  process.env.NODE_ENV = 'test';

  testDb = await setupPgTestDb('rules-eff-dates');

  const mod = await import('../../src/app.js');
  app = mod.default;

  // First-registered user becomes superadmin. We don't need to drive the
  // superadmin agent — we just want a regular household session next.
  const bootstrap = request.agent(app);
  const register = await bootstrap.post('/api/auth/register').send({
    email: 'superadmin@example.com',
    displayName: 'Super Admin',
    password: 'password123',
  });
  assert.equal(register.status, 201);

  const models = await import('../../src/models');
  const { hashPassword, hashToken } = await import('../../src/auth/password.js');
  const password = await hashPassword('password123');
  const user = await models.User.create({
    email: `rules-${Date.now()}-${Math.random().toString(16).slice(2)}@example.com`,
    displayName: 'Rules Owner',
    globalRole: 'user',
    passwordHash: password.hash,
    passwordSalt: password.salt,
    passwordParams: password.params,
  });
  const household = await models.Household.create({ name: 'Rules household' });
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
  agent = request.agent(app);
  agent.jar.setCookie(`cashflow_session=${token}; Path=/`);
});

after(async () => {
  await teardownPgTestDb(testDb);
});

test('POST /api/rules accepts effectiveFrom and effectiveTo', async () => {
  const res = await agent.post('/api/rules').send({
    merchantPattern: 'NETFLIX',
    category: 'Subscriptions',
    effectiveFrom: '2026-01-01',
    effectiveTo: '2026-12-31',
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.merchantPattern, 'NETFLIX');
  assert.equal(res.body.effectiveFrom, '2026-01-01');
  assert.equal(res.body.effectiveTo, '2026-12-31');
});

test('POST /api/rules rejects malformed effectiveFrom with 400', async () => {
  const res = await agent.post('/api/rules').send({
    merchantPattern: 'AMAZON',
    effectiveFrom: 'tomorrow',
  });
  assert.equal(res.status, 400);
  assert.match(String(res.body.error), /effectiveFrom/);
  assert.match(String(res.body.error), /YYYY-MM-DD/);
});

test('POST /api/rules rejects effectiveFrom >= effectiveTo with 400', async () => {
  const res = await agent.post('/api/rules').send({
    merchantPattern: 'SPOTIFY',
    effectiveFrom: '2026-06-01',
    effectiveTo: '2026-06-01',
  });
  assert.equal(res.status, 400);
  assert.match(String(res.body.error), /effectiveFrom must be < effectiveTo/);
});

test('PATCH /api/rules/:id can clear effectiveFrom by passing null', async () => {
  const created = await agent.post('/api/rules').send({
    merchantPattern: 'UBER',
    effectiveFrom: '2026-02-01',
    effectiveTo: '2026-11-30',
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.effectiveFrom, '2026-02-01');
  const id = created.body.id as number;

  const patched = await agent
    .patch(`/api/rules/${id}`)
    .send({ effectiveFrom: null });
  assert.equal(patched.status, 200);
  assert.equal(patched.body.effectiveFrom, null);
  assert.equal(patched.body.effectiveTo, '2026-11-30');
});

test('POST /api/rules rejects calendar-invalid effectiveFrom (2026-13-01)', async () => {
  const res = await agent
    .post('/api/rules')
    .send({ merchantPattern: 'X', effectiveFrom: '2026-13-01' });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /effectiveFrom/);
  assert.match(res.body.error, /valid calendar date/);
});

test('POST /api/rules rejects calendar-invalid effectiveTo (2026-02-30)', async () => {
  const res = await agent
    .post('/api/rules')
    .send({ merchantPattern: 'X', effectiveTo: '2026-02-30' });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /effectiveTo/);
  assert.match(res.body.error, /valid calendar date/);
});

test('PATCH /api/rules/:id rejects effectiveTo that crosses existing effectiveFrom', async () => {
  const created = await agent.post('/api/rules').send({
    merchantPattern: 'GROCER',
    effectiveFrom: '2026-06-01',
  });
  assert.equal(created.status, 201);
  const id = created.body.id;

  const patched = await agent
    .patch(`/api/rules/${id}`)
    .send({ effectiveTo: '2026-05-01' });
  assert.equal(patched.status, 400);
  assert.match(patched.body.error, /effectiveFrom must be < effectiveTo/);
});
