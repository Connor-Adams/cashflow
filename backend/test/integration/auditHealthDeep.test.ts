import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { setupPgTestDb, teardownPgTestDb, type PgTestDb } from './_setup/pgTestDb.js';

let app: import('express').Express;
let authed: ReturnType<typeof request.agent>;
let testDb: PgTestDb;
let auditToken: string;

before(async () => {
  testDb = await setupPgTestDb('audit-health-deep');
  await import('../../src/models/index.js');
  app = (await import('../../src/app.js')).default;
  authed = request.agent(app);
  const register = await authed.post('/api/auth/register').send({
    email: 'audit-hd@example.com',
    displayName: 'Audit HD User',
    password: 'password123',
  });
  assert.equal(register.status, 201);

  const mint = await authed.post('/api/audit/tokens').send({ label: 'HD Test' });
  assert.equal(mint.status, 201);
  auditToken = mint.body.plaintext;
});

after(async () => {
  await teardownPgTestDb(testDb);
});

test('GET /api/audit/health-deep returns expected shape', async () => {
  const res = await request(app)
    .get('/api/audit/health-deep')
    .set('Authorization', `Bearer ${auditToken}`);
  assert.equal(res.status, 200);
  const body = res.body;

  assert.ok(typeof body.ok === 'boolean');
  assert.equal(body.service, 'cashflow-backend');
  assert.ok(typeof body.version === 'string' && body.version.length > 0);
  assert.ok(typeof body.uptimeSeconds === 'number');
  assert.ok(typeof body.timestamp === 'string');

  // DB
  assert.ok(typeof body.db === 'object');
  assert.equal(body.db.reachable, true);
  assert.ok(typeof body.db.latencyMs === 'number' && body.db.latencyMs >= 0);
  assert.equal(body.db.error, null);

  // Migrations
  assert.ok(typeof body.migrations === 'object');
  assert.ok(typeof body.migrations.pending === 'number');
  assert.equal(body.migrations.pending, 0, 'no pending migrations on a fresh test DB');
  assert.ok(typeof body.migrations.appliedCount === 'number' && body.migrations.appliedCount > 0);
  assert.ok(typeof body.migrations.headName === 'string');
  assert.ok(Array.isArray(body.migrations.pendingNames));
  assert.ok(body.ok === true, 'ok should be true on a healthy DB with no pending migrations');
});

test('GET /api/audit/health-deep returns 401 without bearer', async () => {
  const res = await request(app).get('/api/audit/health-deep');
  assert.equal(res.status, 401);
});

test('POST /api/audit/health-deep returns 405', async () => {
  const res = await request(app)
    .post('/api/audit/health-deep')
    .set('Authorization', `Bearer ${auditToken}`);
  assert.equal(res.status, 405);
});
