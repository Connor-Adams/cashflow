/**
 * Integration tests for audit token mint/list/revoke (#387).
 * Mirrors captureTokens.test.ts.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { setupPgTestDb, teardownPgTestDb, type PgTestDb } from './_setup/pgTestDb.js';

let app: import('express').Express;
let authed: ReturnType<typeof request.agent>;
let testDb: PgTestDb;

before(async () => {
  testDb = await setupPgTestDb('audit-tokens');
  await import('../../src/models/index.js');
  app = (await import('../../src/app.js')).default;
  authed = request.agent(app);
  const register = await authed.post('/api/auth/register').send({
    email: 'auditokens@example.com',
    displayName: 'Audit Tokens User',
    password: 'password123',
  });
  assert.equal(register.status, 201);
});

after(async () => {
  await teardownPgTestDb(testDb);
});

test('mints an audit token, lists it (without plaintext), then revokes', async () => {
  const mint = await authed.post('/api/audit/tokens').send({ label: 'My Agent' });
  assert.equal(mint.status, 201);
  assert.match(mint.body.plaintext, /^cfa_[A-Za-z0-9_-]{32}$/);
  assert.equal(mint.body.label, 'My Agent');
  const tokenId = mint.body.id;
  const plaintext = mint.body.plaintext as string;

  const list = await authed.get('/api/audit/tokens');
  assert.equal(list.status, 200);
  assert.equal(list.body.length, 1);
  assert.equal(list.body[0].id, tokenId);
  assert.equal(list.body[0].plaintext, undefined, 'list must never include plaintext');
  assert.equal(list.body[0].tokenHash, undefined, 'list must never include tokenHash');
  assert.equal(list.body[0].label, 'My Agent');

  // Bearer auth on _ping
  const ping = await request(app)
    .get('/api/audit/_ping')
    .set('Authorization', `Bearer ${plaintext}`);
  assert.equal(ping.status, 200);
  assert.deepEqual(ping.body, { ok: true });

  // Revoke
  const revoke = await authed.delete(`/api/audit/tokens/${tokenId}`);
  assert.equal(revoke.status, 204);

  // Token no longer works
  const pingAfter = await request(app)
    .get('/api/audit/_ping')
    .set('Authorization', `Bearer ${plaintext}`);
  assert.equal(pingAfter.status, 401);

  const listAfter = await authed.get('/api/audit/tokens');
  assert.equal(listAfter.status, 200);
  assert.equal(listAfter.body.length, 0);
});

test('audit middleware rejects POST method with 405', async () => {
  const mint = await authed.post('/api/audit/tokens').send({ label: 'Test' });
  assert.equal(mint.status, 201);
  const plaintext = mint.body.plaintext as string;

  // POST to audit router should be 405
  const postRes = await request(app)
    .post('/api/audit/_ping')
    .set('Authorization', `Bearer ${plaintext}`)
    .send({});
  assert.equal(postRes.status, 405);
});

test('audit middleware rejects missing/invalid tokens with 401', async () => {
  const noToken = await request(app).get('/api/audit/_ping');
  assert.equal(noToken.status, 401);

  const wrongPrefix = await request(app)
    .get('/api/audit/_ping')
    .set('Authorization', 'Bearer cfc_aBcDeFgHiJkLmNoPqRsTuVwXyZ01234_');
  assert.equal(wrongPrefix.status, 401);
});

test('rejects unauthenticated calls to audit tokens CRUD', async () => {
  const res = await request(app).post('/api/audit/tokens').send({ label: 'x' });
  assert.equal(res.status, 401);
});
