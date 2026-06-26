/**
 * Integration tests for #818: ReDoS via user-supplied regex patterns.
 *
 * Asserts that the rule-creation/update/preview routes reject over-long and
 * catastrophic-backtracking regex patterns with a 400 instead of compiling and
 * running them on the event loop.
 *
 * Run in isolation (`yarn test:integration`) so DATABASE_URL is set before any
 * Sequelize import.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import request from 'supertest';
import { testAgent } from './_setup/testServer.js';
import { setupPgTestDb, teardownPgTestDb, type PgTestDb } from './_setup/pgTestDb.js';

let app: import('express').Express;
let agent: ReturnType<typeof request.agent>;
let testDb: PgTestDb;

before(async () => {
  process.env.NODE_ENV = 'test';

  testDb = await setupPgTestDb('rules-regex-safety');

  const mod = await import('../../src/app.js');
  app = mod.default;

  const bootstrap = testAgent(app);
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
    email: `regex-${Date.now()}-${Math.random().toString(16).slice(2)}@example.com`,
    displayName: 'Regex Owner',
    globalRole: 'user',
    passwordHash: password.hash,
    passwordSalt: password.salt,
    passwordParams: password.params,
  });
  const household = await models.Household.create({ name: 'Regex household' });
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
  agent = testAgent(app);
  agent.jar.setCookie(`cashflow_session=${token}; Path=/`);
});

after(async () => {
  await teardownPgTestDb(testDb);
});

test('POST /api/rules accepts a safe regex rule', async () => {
  const res = await agent.post('/api/rules').send({
    merchantPattern: 'amazon|amzn',
    matchKind: 'regex',
    category: 'Shopping',
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.merchantPattern, 'amazon|amzn');
});

test('POST /api/rules rejects a catastrophic-backtracking regex with 400', async () => {
  const res = await agent.post('/api/rules').send({
    merchantPattern: '(a+)+$',
    matchKind: 'regex',
    category: 'Shopping',
  });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'UNSAFE_PATTERN');
});

test('POST /api/rules rejects an over-long regex with 400', async () => {
  const res = await agent.post('/api/rules').send({
    merchantPattern: 'a'.repeat(500),
    matchKind: 'regex',
    category: 'Shopping',
  });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'PATTERN_TOO_LONG');
});

test('POST /api/rules allows an over-long substring pattern (not compiled)', async () => {
  const res = await agent.post('/api/rules').send({
    merchantPattern: 'a'.repeat(500),
    matchKind: 'substring',
    category: 'Shopping',
  });
  assert.equal(res.status, 201);
});

test('PATCH /api/rules/:id rejects editing a rule into an unsafe regex', async () => {
  const created = await agent.post('/api/rules').send({
    merchantPattern: 'starbucks',
    matchKind: 'regex',
    category: 'Coffee',
  });
  assert.equal(created.status, 201);
  const id = created.body.id as number;

  const patched = await agent
    .patch(`/api/rules/${id}`)
    .send({ merchantPattern: '(x+)+$' });
  assert.equal(patched.status, 400);
  assert.equal(patched.body.error, 'UNSAFE_PATTERN');
});

test('PATCH /api/rules/:id rejects switching matchKind to regex with an unsafe stored pattern', async () => {
  const created = await agent.post('/api/rules').send({
    merchantPattern: '(a*)*',
    matchKind: 'substring',
    category: 'Coffee',
  });
  assert.equal(created.status, 201);
  const id = created.body.id as number;

  const patched = await agent
    .patch(`/api/rules/${id}`)
    .send({ matchKind: 'regex' });
  assert.equal(patched.status, 400);
  assert.equal(patched.body.error, 'UNSAFE_PATTERN');
});

test('POST /api/rules/preview-pattern rejects an unsafe regex and returns promptly', async () => {
  const start = Date.now();
  const res = await agent.post('/api/rules/preview-pattern').send({
    pattern: '(a+)+$',
    matchType: 'regex',
  });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'UNSAFE_PATTERN');
  assert.ok(Date.now() - start < 2000, 'must not block the event loop');
});

test('POST /api/rules/preview-pattern accepts a safe regex', async () => {
  const res = await agent.post('/api/rules/preview-pattern').send({
    pattern: 'coffee',
    matchType: 'regex',
  });
  assert.equal(res.status, 200);
  assert.ok(typeof res.body.matches === 'number');
});
