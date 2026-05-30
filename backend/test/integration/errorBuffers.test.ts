/**
 * Integration tests for client/server error ring buffers (#392, #393).
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import request from 'supertest';
import { setupPgTestDb, teardownPgTestDb, type PgTestDb } from './_setup/pgTestDb.js';

let app: import('express').Express;
let agent: ReturnType<typeof request.agent>;
let validToken: string;
let householdId: number;
let userId: number;
let testDb: PgTestDb;

before(async () => {
  testDb = await setupPgTestDb('error_buffers');
  process.env.DATABASE_URL = testDb.databaseUrl;
  app = (await import('../../src/app.js')).default;

  const models = await import('../../src/models/index.js');
  const { hashPassword, hashToken } = await import('../../src/auth/password.js');
  const { mintAuditTokenPlaintext, hashAuditToken } = await import(
    '../../src/auth/auditToken.js'
  );
  const password = await hashPassword('password123');
  const user = await models.User.create({
    email: `err-buf-${Date.now()}@example.com`,
    displayName: 'errbuf',
    globalRole: 'user',
    passwordHash: password.hash,
    passwordSalt: password.salt,
    passwordParams: password.params,
  });
  const household = await models.Household.create({ name: 'errbuf household' });
  await models.HouseholdMember.create({
    householdId: household.id,
    userId: user.id,
    role: 'owner',
  });
  householdId = household.id;
  userId = user.id;
  const sess = crypto.randomBytes(32).toString('hex');
  await models.Session.create({
    userId: user.id,
    tokenHash: hashToken(sess),
    expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24),
  });
  agent = request.agent(app);
  agent.jar.setCookie(`cashflow_session=${sess}`);

  validToken = mintAuditTokenPlaintext();
  await models.UserAuditToken.create({
    userId: user.id,
    tokenHash: hashAuditToken(validToken),
    label: 'errbuf-token',
    lastUsedAt: null,
    revokedAt: null,
  });
});

after(async () => {
  await teardownPgTestDb(testDb);
});

// ── client-error buffer ──────────────────────────────────────────────────────

test('POST /api/client-logs with level=error persists ClientErrorEvent', async () => {
  const res = await agent.post('/api/client-logs').send({
    level: 'error',
    event: 'page.crash',
    message: 'TypeError: cannot read x of undefined',
    path: '/transactions',
  });
  assert.equal(res.status, 204);
  await new Promise((r) => setTimeout(r, 150));
  const models = await import('../../src/models/index.js');
  const rows = await models.ClientErrorEvent.findAll({ where: { userId } });
  assert.ok(rows.length >= 1);
  const row = rows.find((r) => r.event === 'page.crash');
  assert.ok(row);
  assert.ok(row.message.startsWith('TypeError'));
});

test('POST /api/client-logs with level=info does NOT persist', async () => {
  const models = await import('../../src/models/index.js');
  const before = await models.ClientErrorEvent.count({ where: { userId } });
  await agent.post('/api/client-logs').send({
    level: 'info',
    event: 'page.view',
    message: 'just browsing',
    path: '/',
  });
  await new Promise((r) => setTimeout(r, 150));
  const after = await models.ClientErrorEvent.count({ where: { userId } });
  assert.equal(after, before);
});

test('GET /api/audit/client-errors returns buffered errors scoped to household', async () => {
  const models = await import('../../src/models/index.js');
  await models.ClientErrorEvent.create({
    householdId,
    userId,
    level: 'error',
    event: 'deploy.smoke',
    message: 'after-deploy crash',
    path: '/forecast',
    requestId: 'req-999',
    fieldsJson: null,
  });
  const res = await request(app)
    .get('/api/audit/client-errors?limit=50')
    .set('Authorization', `Bearer ${validToken}`);
  assert.equal(res.status, 200);
  assert.equal(typeof res.body.count, 'number');
  assert.ok(Array.isArray(res.body.rows));
  const row = res.body.rows.find((r: { event: string }) => r.event === 'deploy.smoke');
  assert.ok(row);
  assert.equal(row.path, '/forecast');
});

test('GET /api/audit/client-errors?since=future returns count 0', async () => {
  const future = new Date(Date.now() + 60_000).toISOString();
  const res = await request(app)
    .get(`/api/audit/client-errors?since=${encodeURIComponent(future)}`)
    .set('Authorization', `Bearer ${validToken}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.count, 0);
});

// ── server-error buffer ──────────────────────────────────────────────────────

test('GET /api/audit/server-errors returns seeded error rows', async () => {
  const models = await import('../../src/models/index.js');
  await models.ServerErrorEvent.create({
    householdId,
    userId,
    method: 'GET',
    path: '/api/transactions',
    status: 500,
    message: 'Database exploded',
    stack: null,
    requestId: 'srv-req-1',
  });
  const res = await request(app)
    .get('/api/audit/server-errors?limit=50')
    .set('Authorization', `Bearer ${validToken}`);
  assert.equal(res.status, 200);
  assert.equal(typeof res.body.count, 'number');
  assert.ok(Array.isArray(res.body.rows));
  const row = res.body.rows.find(
    (r: { message: string }) => r.message === 'Database exploded',
  );
  assert.ok(row);
  assert.equal(row.method, 'GET');
  assert.equal(row.status, 500);
});

test('GET /api/audit/server-errors?since=future returns count 0', async () => {
  const future = new Date(Date.now() + 60_000).toISOString();
  const res = await request(app)
    .get(`/api/audit/server-errors?since=${encodeURIComponent(future)}`)
    .set('Authorization', `Bearer ${validToken}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.count, 0);
});
