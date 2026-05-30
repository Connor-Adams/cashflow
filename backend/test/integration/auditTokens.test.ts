import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import request from 'supertest';
import { setupPgTestDb, teardownPgTestDb, type PgTestDb } from './_setup/pgTestDb.js';

let app: import('express').Express;
let agent: ReturnType<typeof request.agent>;
let testDb: PgTestDb;

before(async () => {
  testDb = await setupPgTestDb('audit_tokens');
  process.env.DATABASE_URL = testDb.databaseUrl;
  const mod = await import('../../src/app.js');
  app = mod.default;

  const models = await import('../../src/models/index.js');
  const { hashPassword, hashToken } = await import('../../src/auth/password.js');
  const password = await hashPassword('password123');
  const user = await models.User.create({
    email: `audit-tokens-${Date.now()}@example.com`,
    displayName: 'auditor',
    globalRole: 'user',
    passwordHash: password.hash,
    passwordSalt: password.salt,
    passwordParams: password.params,
  });
  const household = await models.Household.create({ name: 'audit household' });
  await models.HouseholdMember.create({
    householdId: household.id,
    userId: user.id,
    role: 'owner',
  });
  const sess = crypto.randomBytes(32).toString('hex');
  await models.Session.create({
    userId: user.id,
    tokenHash: hashToken(sess),
    expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24),
  });
  agent = request.agent(app);
  agent.jar.setCookie(`cashflow_session=${sess}`);
});

after(async () => {
  await teardownPgTestDb(testDb);
});

test('POST /api/audit/tokens mints a cfa_ token and returns plaintext once', async () => {
  const res = await agent.post('/api/audit/tokens').send({ label: 'ci-bot' });
  assert.equal(res.status, 201);
  assert.match(res.body.plaintext, /^cfa_[A-Za-z0-9_-]{32}$/);
  assert.equal(res.body.label, 'ci-bot');
  assert.ok(res.body.id);
});

test('POST /api/audit/tokens defaults label when empty', async () => {
  const res = await agent.post('/api/audit/tokens').send({});
  assert.equal(res.status, 201);
  assert.equal(res.body.label, 'Audit');
});

test('POST /api/audit/tokens rejects label > 64 chars', async () => {
  const res = await agent.post('/api/audit/tokens').send({ label: 'x'.repeat(65) });
  assert.equal(res.status, 400);
});

test('GET /api/audit/tokens lists non-revoked tokens for user', async () => {
  const res = await agent.get('/api/audit/tokens');
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body));
  assert.ok(res.body.length >= 1);
  for (const row of res.body) {
    assert.ok('id' in row);
    assert.ok('label' in row);
    assert.ok('createdAt' in row);
    assert.ok(!('plaintext' in row), 'plaintext must NEVER appear in list');
    assert.ok(!('tokenHash' in row), 'hash must NEVER appear in list');
  }
});

test('DELETE /api/audit/tokens/:id revokes the token (soft delete)', async () => {
  const mint = await agent.post('/api/audit/tokens').send({ label: 'revoke-me' });
  const id = mint.body.id;
  const del = await agent.delete(`/api/audit/tokens/${id}`);
  assert.equal(del.status, 204);
  const list = await agent.get('/api/audit/tokens');
  assert.ok(!list.body.some((r: { id: number }) => r.id === id));
});

test('DELETE /api/audit/tokens/:id returns 404 for unknown id', async () => {
  const del = await agent.delete('/api/audit/tokens/999999');
  assert.equal(del.status, 404);
});

test('mint/list/revoke require session auth', async () => {
  const anon = request(app);
  const mint = await anon.post('/api/audit/tokens').send({});
  assert.equal(mint.status, 401);
  const list = await anon.get('/api/audit/tokens');
  assert.equal(list.status, 401);
});
