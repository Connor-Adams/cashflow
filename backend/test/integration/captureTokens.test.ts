import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { testAgent, testRequest } from './_setup/testServer.js';
import { setupPgTestDb, teardownPgTestDb, type PgTestDb } from './_setup/pgTestDb.js';

let app: import('express').Express;
let authed: ReturnType<typeof request.agent>;
let models: typeof import('../../src/models/index.js');
let testDb: PgTestDb;

before(async () => {
  testDb = await setupPgTestDb('capture-tokens');
  models = await import('../../src/models/index.js');
  app = (await import('../../src/app.js')).default;
  authed = testAgent(app);
  const register = await authed.post('/api/auth/register').send({
    email: 'tokens@example.com',
    displayName: 'Tokens User',
    password: 'password123',
  });
  assert.equal(register.status, 201);
});

after(async () => {
  await teardownPgTestDb(testDb);
});

test('mints a token, lists it (without plaintext), then revokes', async () => {
  const mint = await authed.post('/api/capture/tokens').send({ label: 'My Mac' });
  assert.equal(mint.status, 201);
  assert.match(mint.body.plaintext, /^cfc_[A-Za-z0-9_-]{32}$/);
  assert.equal(mint.body.label, 'My Mac');
  // Issue #829: minted tokens carry a server-side expiry in the future.
  assert.ok(mint.body.expiresAt, 'mint response must include expiresAt');
  assert.ok(new Date(mint.body.expiresAt).getTime() > Date.now());
  const tokenId = mint.body.id;

  const list = await authed.get('/api/capture/tokens');
  assert.equal(list.status, 200);
  assert.equal(list.body.length, 1);
  assert.equal(list.body[0].id, tokenId);
  assert.equal(list.body[0].plaintext, undefined, 'list must never include plaintext');
  assert.equal(list.body[0].tokenHash, undefined, 'list must never include tokenHash');
  assert.equal(list.body[0].userId, undefined, 'list must never include userId');
  assert.equal(list.body[0].label, 'My Mac');
  assert.ok(list.body[0].expiresAt, 'list must include expiresAt');

  const revoke = await authed.delete(`/api/capture/tokens/${tokenId}`);
  assert.equal(revoke.status, 204);

  const listAfter = await authed.get('/api/capture/tokens');
  assert.equal(listAfter.status, 200);
  assert.equal(listAfter.body.length, 0);
});

test('rejects unauthenticated calls', async () => {
  const res = await testRequest(app).post('/api/capture/tokens').send({ label: 'x' });
  assert.equal(res.status, 401);
});
