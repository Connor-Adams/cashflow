/**
 * Integration tests for the audit bearer-auth middleware (#387).
 * Tests the requireAuditAuth guard in isolation.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { setupPgTestDb, teardownPgTestDb, type PgTestDb } from './_setup/pgTestDb.js';

let app: import('express').Express;
let authed: ReturnType<typeof request.agent>;
let testDb: PgTestDb;
let mintedPlaintext: string;

before(async () => {
  testDb = await setupPgTestDb('audit-middleware');
  await import('../../src/models/index.js');
  app = (await import('../../src/app.js')).default;
  authed = request.agent(app);
  const register = await authed.post('/api/auth/register').send({
    email: 'auditmw@example.com',
    displayName: 'Audit MW User',
    password: 'password123',
  });
  assert.equal(register.status, 201);

  // Mint a token for subsequent bearer-auth tests
  const mint = await authed.post('/api/audit/tokens').send({ label: 'MW Test' });
  assert.equal(mint.status, 201);
  mintedPlaintext = mint.body.plaintext as string;
});

after(async () => {
  await teardownPgTestDb(testDb);
});

test('GET /api/audit/_ping succeeds with valid bearer token', async () => {
  const res = await request(app)
    .get('/api/audit/_ping')
    .set('Authorization', `Bearer ${mintedPlaintext}`);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { ok: true });
});

test('GET /api/audit/_ping returns 401 without Authorization header', async () => {
  const res = await request(app).get('/api/audit/_ping');
  assert.equal(res.status, 401);
});

test('GET /api/audit/_ping returns 401 with malformed bearer token', async () => {
  const res = await request(app)
    .get('/api/audit/_ping')
    .set('Authorization', 'Bearer not_a_valid_token');
  assert.equal(res.status, 401);
});

test('GET /api/audit/_ping returns 401 with cfc_ (capture) token format', async () => {
  // Capture token format should be rejected by audit middleware
  const res = await request(app)
    .get('/api/audit/_ping')
    .set('Authorization', 'Bearer cfc_aBcDeFgHiJkLmNoPqRsTuVwXyZ01234_');
  assert.equal(res.status, 401);
});

test('POST /api/audit/_ping returns 405 (method not allowed)', async () => {
  const res = await request(app)
    .post('/api/audit/_ping')
    .set('Authorization', `Bearer ${mintedPlaintext}`)
    .send({});
  assert.equal(res.status, 405);
});

test('GET /api/audit/integrity responds with valid structure', async () => {
  const res = await request(app)
    .get('/api/audit/integrity')
    .set('Authorization', `Bearer ${mintedPlaintext}`);
  assert.equal(res.status, 200);
  assert.ok(typeof res.body.duplicateGroups === 'object');
  assert.ok(typeof res.body.unenrichedTransactions === 'number');
  assert.ok(typeof res.body.orphanedTransactions === 'number');
  assert.ok(typeof res.body.generatedAt === 'string');
});

test('GET /api/audit/counts responds with valid structure', async () => {
  const res = await request(app)
    .get('/api/audit/counts')
    .set('Authorization', `Bearer ${mintedPlaintext}`);
  assert.equal(res.status, 200);
  assert.ok(typeof res.body.counts === 'object');
  assert.ok(typeof res.body.counts.transactions === 'number');
  assert.ok(typeof res.body.generatedAt === 'string');
});
