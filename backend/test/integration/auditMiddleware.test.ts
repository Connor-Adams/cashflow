import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { setupPgTestDb, teardownPgTestDb, type PgTestDb } from './_setup/pgTestDb.js';

let app: import('express').Express;
let authed: ReturnType<typeof request.agent>;
let testDb: PgTestDb;
let captureToken: string;
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

  const mintAudit = await authed.post('/api/audit/tokens').send({ label: 'Test' });
  assert.equal(mintAudit.status, 201);
  auditToken = mintAudit.body.plaintext;

  const mintCapture = await authed.post('/api/capture/tokens').send({ label: 'Import' });
  assert.equal(mintCapture.status, 201);
  captureToken = mintCapture.body.plaintext;
});

after(async () => {
  await teardownPgTestDb(testDb);
});

test('_ping succeeds with valid cfa_ bearer', async () => {
  const res = await request(app)
    .get('/api/audit/_ping')
    .set('Authorization', `Bearer ${auditToken}`);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { ok: true });
});

test('_ping returns 401 without Authorization', async () => {
  const res = await request(app).get('/api/audit/_ping');
  assert.equal(res.status, 401);
});

test('_ping returns 401 with a cfc_ token', async () => {
  const res = await request(app)
    .get('/api/audit/_ping')
    .set('Authorization', `Bearer ${captureToken}`);
  assert.equal(res.status, 401);
});

test('_ping returns 401 with garbage token', async () => {
  const res = await request(app)
    .get('/api/audit/_ping')
    .set('Authorization', 'Bearer notavalidtoken');
  assert.equal(res.status, 401);
});

test('_ping returns 401 for revoked token', async () => {
  const mint = await authed.post('/api/audit/tokens').send({ label: 'Revoke Me' });
  assert.equal(mint.status, 201);
  const revokeToken = mint.body.plaintext;
  const tokenId = mint.body.id;

  await authed.delete(`/api/audit/tokens/${tokenId}`);

  const res = await request(app)
    .get('/api/audit/_ping')
    .set('Authorization', `Bearer ${revokeToken}`);
  assert.equal(res.status, 401);
});

test('POST to _ping returns 405', async () => {
  const res = await request(app)
    .post('/api/audit/_ping')
    .set('Authorization', `Bearer ${auditToken}`);
  assert.equal(res.status, 405);
});

test('last_used_at is bumped after successful auth', async () => {
  const models = await import('../../src/models/index.js');
  const before_ = await models.UserAuditToken.findOne({
    where: { tokenHash: (await import('../../src/auth/auditToken.js')).hashAuditToken(auditToken) },
  });
  const beforeTs = before_?.lastUsedAt ?? null;

  await request(app)
    .get('/api/audit/_ping')
    .set('Authorization', `Bearer ${auditToken}`);

  // Wait briefly for best-effort async update
  await new Promise((r) => setTimeout(r, 100));

  const after_ = await models.UserAuditToken.findOne({
    where: { tokenHash: (await import('../../src/auth/auditToken.js')).hashAuditToken(auditToken) },
  });
  assert.ok(after_?.lastUsedAt != null, 'lastUsedAt should be set');
  if (beforeTs != null) {
    assert.ok(
      after_!.lastUsedAt!.getTime() >= beforeTs.getTime(),
      'lastUsedAt should be >= previous value',
    );
  }
});
