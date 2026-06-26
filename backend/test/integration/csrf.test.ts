/**
 * Integration tests for CSRF protection on mutating /api routes (issue #825).
 *
 * Exercises the full Express pipeline (`backend/src/auth/csrf.ts` mounted in
 * app.ts) against a real registered session: a cookie-authed POST/DELETE that
 * carries a foreign Origin is rejected with 403 before it reaches the route,
 * while the same request from the configured frontend origin succeeds. Proves
 * the AC: "a cross-origin POST without the CSRF signal is rejected".
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { testAgent } from './_setup/testServer.js';
import { setupPgTestDb, teardownPgTestDb, type PgTestDb } from './_setup/pgTestDb.js';

const ALLOWED_ORIGIN = 'http://localhost:5173';

let app: import('express').Express;
let authed: ReturnType<typeof request.agent>;
let testDb: PgTestDb;
const origCors = process.env.CORS_ORIGIN;

before(async () => {
  process.env.NODE_ENV = 'test';
  process.env.CORS_ORIGIN = ALLOWED_ORIGIN;
  testDb = await setupPgTestDb('csrf');
  app = (await import('../../src/app.js')).default;
  authed = testAgent(app);
  await authed.post('/api/auth/register').send({
    email: 'csrf@example.com',
    displayName: 'CSRF Tester',
    password: 'password123',
  });
});

after(async () => {
  if (origCors === undefined) delete process.env.CORS_ORIGIN;
  else process.env.CORS_ORIGIN = origCors;
  await teardownPgTestDb(testDb);
});

test('cookie-authed POST from a foreign Origin is rejected with 403', async () => {
  const res = await authed
    .post('/api/categories')
    .set('Origin', 'https://evil.example.org')
    .send({ name: 'Forged', parentId: null });
  assert.equal(res.status, 403);
  assert.match(String(res.body.error), /cross-origin/i);
});

test('cookie-authed DELETE from a foreign Origin is rejected with 403', async () => {
  const res = await authed
    .delete('/api/household/members/999999')
    .set('Origin', 'https://evil.example.org');
  assert.equal(res.status, 403);
  assert.match(String(res.body.error), /cross-origin/i);
});

test('cookie-authed POST from the configured frontend Origin succeeds', async () => {
  const res = await authed
    .post('/api/categories')
    .set('Origin', ALLOWED_ORIGIN)
    .send({ name: 'Legit', parentId: null });
  assert.equal(res.status, 201);
  assert.equal(res.body.name, 'Legit');
});

test('a GET from a foreign Origin is NOT blocked (safe method)', async () => {
  const res = await authed
    .get('/api/categories')
    .set('Origin', 'https://evil.example.org');
  assert.equal(res.status, 200);
});
