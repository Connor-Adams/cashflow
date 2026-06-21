/**
 * Integration tests for GET /api/simplefin/status and
 * POST /api/simplefin/disconnect (issue #790), AC 8–10. Postgres-backed.
 * Asserts the masked status shape (host only, never credentials), idempotent
 * disconnect, and 401 when unauthenticated.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { testAgent, testRequest } from './_setup/testServer.js';
import { setupPgTestDb, teardownPgTestDb, type PgTestDb } from './_setup/pgTestDb.js';

const ACCESS_URL = 'https://u53r:s3cr3t@beta-bridge.simplefin.org/simplefin';

let app: import('express').Express;
let authed: ReturnType<typeof request.agent>;
let models: typeof import('../../src/models/index.js');
let testDb: PgTestDb;
let userId: number;

before(async () => {
  process.env.EMAIL_INTEGRATION_ENCRYPTION_KEY =
    '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';
  testDb = await setupPgTestDb('simplefin-status');
  models = await import('../../src/models/index.js');
  const enc = await import('../../src/util/symmetricEncryption.js');
  enc.__resetKeyCacheForTests();
  app = (await import('../../src/app.js')).default;
  authed = testAgent(app);
  const register = await authed.post('/api/auth/register').send({
    email: 'sfstatus@example.com',
    displayName: 'SF Status',
    password: 'password123',
  });
  assert.equal(register.status, 201);
  const user = await models.User.findOne();
  assert.ok(user);
  userId = user.id;
});

after(async () => {
  await teardownPgTestDb(testDb);
});

test('AC8: status reports connected:false / host:null when no row exists', async () => {
  const res = await authed.get('/api/simplefin/status');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, {
    connected: false,
    status: 'disconnected',
    statusReason: null,
    lastSyncedAt: null,
    host: null,
  });
});

test('AC8: status reports connected:true with masked host, never credentials', async () => {
  const enc = await import('../../src/util/symmetricEncryption.js');
  await models.UserSimplefinIntegration.create({
    userId,
    accessUrlEncrypted: enc.encryptSecret(ACCESS_URL),
    status: 'connected',
    statusReason: null,
    lastSyncedAt: null,
  } as never);

  const res = await authed.get('/api/simplefin/status');
  assert.equal(res.status, 200);
  assert.equal(res.body.connected, true);
  assert.equal(res.body.status, 'connected');
  assert.equal(res.body.host, 'beta-bridge.simplefin.org');
  assert.equal(res.body.lastSyncedAt, null);
  // The credentials must NEVER appear anywhere in the response.
  const blob = JSON.stringify(res.body);
  assert.ok(!blob.includes('s3cr3t'), 'password must not leak');
  assert.ok(!blob.includes('u53r'), 'username must not leak');
  assert.ok(!blob.includes(ACCESS_URL), 'full access URL must not leak');
});

test('AC9 + AC10: disconnect removes the row and is idempotent', async () => {
  // A row exists from the prior test.
  const first = await authed.post('/api/simplefin/disconnect');
  assert.equal(first.status, 200);
  assert.deepEqual(first.body, { status: 'disconnected' });
  assert.equal(await models.UserSimplefinIntegration.count({ where: { userId } }), 0);

  // Calling again with no row is still a clean 200 (idempotent).
  const second = await authed.post('/api/simplefin/disconnect');
  assert.equal(second.status, 200);
  assert.deepEqual(second.body, { status: 'disconnected' });
});

test('AC10: all three routes 401 without a session', async () => {
  const connect = await testRequest(app)
    .post('/api/simplefin/connect')
    .send({ setupToken: 'x' });
  assert.equal(connect.status, 401);
  const status = await testRequest(app).get('/api/simplefin/status');
  assert.equal(status.status, 401);
  const disconnect = await testRequest(app).post('/api/simplefin/disconnect');
  assert.equal(disconnect.status, 401);
});
