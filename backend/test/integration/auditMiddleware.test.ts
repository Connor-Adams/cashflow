import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { setupPgTestDb, teardownPgTestDb, type PgTestDb } from './_setup/pgTestDb.js';

let app: import('express').Express;
let authed: ReturnType<typeof request.agent>;
let testDb: PgTestDb;
let auditToken: string;

before(async () => {
  testDb = await setupPgTestDb('audit-middleware');
  await import('../../src/models/index.js');
  app = (await import('../../src/app.js')).default;
  authed = request.agent(app);
  const register = await authed.post('/api/auth/register').send({
    email: 'audit-mw@example.com',
    displayName: 'Audit MW User',
    password: 'password123',
  });
  assert.equal(register.status, 201);
  const mint = await authed.post('/api/audit/tokens').send({ label: 'Test' });
  assert.equal(mint.status, 201);
  auditToken = mint.body.plaintext;
});

after(async () => {
  await teardownPgTestDb(testDb);
});

test('GET _ping with valid bearer returns {ok: true}', async () => {
  const res = await request(app)
    .get('/api/audit/_ping')
    .set('Authorization', `Bearer ${auditToken}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
});

test('GET _ping without Authorization returns 401', async () => {
  const res = await request(app).get('/api/audit/_ping');
  assert.equal(res.status, 401);
});

test('GET _ping with cfc_ token returns 401', async () => {
  const res = await request(app)
    .get('/api/audit/_ping')
    .set('Authorization', 'Bearer cfc_aBcDeFgHiJkLmNoPqRsTuVwXyZ01234_');
  assert.equal(res.status, 401);
});

test('POST _ping with valid bearer returns 405', async () => {
  const res = await request(app)
    .post('/api/audit/_ping')
    .set('Authorization', `Bearer ${auditToken}`);
  assert.equal(res.status, 405);
});
