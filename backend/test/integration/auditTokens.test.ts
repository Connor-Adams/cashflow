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
    email: 'audit-tokens@example.com',
    displayName: 'Audit Token User',
    password: 'password123',
  });
  assert.equal(register.status, 201);
});

after(async () => {
  await teardownPgTestDb(testDb);
});

test('mints a token, lists it (without plaintext), then revokes', async () => {
  const mint = await authed.post('/api/audit/tokens').send({ label: 'CI Agent' });
  assert.equal(mint.status, 201);
  assert.match(mint.body.plaintext, /^cfa_[A-Za-z0-9_-]{32}$/);
  assert.equal(mint.body.label, 'CI Agent');
  const tokenId = mint.body.id;

  const list = await authed.get('/api/audit/tokens');
  assert.equal(list.status, 200);
  assert.equal(list.body.length, 1);
  assert.equal(list.body[0].id, tokenId);
  assert.equal(list.body[0].plaintext, undefined, 'list must never include plaintext');
  assert.equal(list.body[0].tokenHash, undefined, 'list must never include tokenHash');
  assert.equal(list.body[0].label, 'CI Agent');

  const revoke = await authed.delete(`/api/audit/tokens/${tokenId}`);
  assert.equal(revoke.status, 204);

  const listAfter = await authed.get('/api/audit/tokens');
  assert.equal(listAfter.status, 200);
  assert.equal(listAfter.body.length, 0);
});

test('rejects unauthenticated calls to mint', async () => {
  const res = await request(app).post('/api/audit/tokens').send({ label: 'x' });
  assert.equal(res.status, 401);
});

test('defaults label to "Audit" when omitted', async () => {
  const mint = await authed.post('/api/audit/tokens').send({});
  assert.equal(mint.status, 201);
  assert.equal(mint.body.label, 'Default');
  await authed.delete(`/api/audit/tokens/${mint.body.id}`);
});

test('rejects label longer than 64 chars', async () => {
  const mint = await authed.post('/api/audit/tokens').send({ label: 'x'.repeat(65) });
  assert.equal(mint.status, 400);
});

test('revoke of unknown id returns 404', async () => {
  const res = await authed.delete('/api/audit/tokens/999999');
  assert.equal(res.status, 404);
});
