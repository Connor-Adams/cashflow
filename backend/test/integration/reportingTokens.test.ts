import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { setupPgTestDb, teardownPgTestDb, type PgTestDb } from './_setup/pgTestDb.js';

let app: import('express').Express;
let authed: ReturnType<typeof request.agent>;
let testDb: PgTestDb;

before(async () => {
  testDb = await setupPgTestDb('reporting-tokens');
  await import('../../src/models/index.js');
  app = (await import('../../src/app.js')).default;
  authed = request.agent(app);
  const register = await authed.post('/api/auth/register').send({
    email: 'reporting-tokens@example.com',
    displayName: 'Reporting Tokens User',
    password: 'password123',
  });
  assert.equal(register.status, 201);
});

after(async () => {
  await teardownPgTestDb(testDb);
});

test('mints a token, lists it (without secrets), then revokes', async () => {
  const mint = await authed.post('/api/v1/tokens').send({ label: 'My Script' });
  assert.equal(mint.status, 201);
  assert.match(mint.body.plaintext, /^cfr_[A-Za-z0-9_-]{32}$/);
  assert.equal(mint.body.label, 'My Script');
  const tokenId = mint.body.id;

  const list = await authed.get('/api/v1/tokens');
  assert.equal(list.status, 200);
  assert.equal(list.body.length, 1);
  assert.equal(list.body[0].id, tokenId);
  assert.equal(list.body[0].plaintext, undefined, 'list must never include plaintext');
  assert.equal(list.body[0].tokenHash, undefined, 'list must never include tokenHash');
  assert.equal(list.body[0].label, 'My Script');

  const revoke = await authed.delete(`/api/v1/tokens/${tokenId}`);
  assert.equal(revoke.status, 204);

  const listAfter = await authed.get('/api/v1/tokens');
  assert.equal(listAfter.status, 200);
  assert.equal(listAfter.body.length, 0);
});

test('defaults label to "Reporting" when not provided', async () => {
  const mint = await authed.post('/api/v1/tokens').send({});
  assert.equal(mint.status, 201);
  assert.equal(mint.body.label, 'Reporting');
});

test('rejects label longer than 64 chars', async () => {
  const mint = await authed.post('/api/v1/tokens').send({ label: 'x'.repeat(65) });
  assert.equal(mint.status, 400);
});

test('returns 404 for unknown token id', async () => {
  const res = await authed.delete('/api/v1/tokens/999999');
  assert.equal(res.status, 404);
});

test('rejects unauthenticated mint', async () => {
  const res = await request(app).post('/api/v1/tokens').send({ label: 'x' });
  assert.equal(res.status, 401);
});
