import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { setupPgTestDb, teardownPgTestDb, type PgTestDb } from './_setup/pgTestDb.js';

let app: import('express').Express;
let validToken: string;
let revokedToken: string;
let testDb: PgTestDb;

before(async () => {
  testDb = await setupPgTestDb('audit_middleware');
  process.env.DATABASE_URL = testDb.databaseUrl;
  app = (await import('../../src/app.js')).default;

  const models = await import('../../src/models/index.js');
  const { hashPassword } = await import('../../src/auth/password.js');
  const { mintAuditTokenPlaintext, hashAuditToken } = await import(
    '../../src/auth/auditToken.js'
  );
  const password = await hashPassword('password123');
  const user = await models.User.create({
    email: `audit-mw-${Date.now()}@example.com`,
    displayName: 'mw',
    globalRole: 'user',
    passwordHash: password.hash,
    passwordSalt: password.salt,
    passwordParams: password.params,
  });
  const household = await models.Household.create({ name: 'mw household' });
  await models.HouseholdMember.create({
    householdId: household.id,
    userId: user.id,
    role: 'owner',
  });
  validToken = mintAuditTokenPlaintext();
  await models.UserAuditToken.create({
    userId: user.id,
    tokenHash: hashAuditToken(validToken),
    label: 'valid',
    lastUsedAt: null,
    revokedAt: null,
  });
  revokedToken = mintAuditTokenPlaintext();
  await models.UserAuditToken.create({
    userId: user.id,
    tokenHash: hashAuditToken(revokedToken),
    label: 'revoked',
    lastUsedAt: null,
    revokedAt: new Date(),
  });
});

after(async () => {
  await teardownPgTestDb(testDb);
});

test('GET /api/audit/_ping with valid token returns 200', async () => {
  const res = await request(app)
    .get('/api/audit/_ping')
    .set('Authorization', `Bearer ${validToken}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
});

test('GET /api/audit/_ping without Authorization returns 401', async () => {
  const res = await request(app).get('/api/audit/_ping');
  assert.equal(res.status, 401);
});

test('GET /api/audit/_ping with cfc_ token returns 401', async () => {
  const res = await request(app)
    .get('/api/audit/_ping')
    .set('Authorization', 'Bearer cfc_' + 'A'.repeat(32));
  assert.equal(res.status, 401);
});

test('GET /api/audit/_ping with revoked token returns 401', async () => {
  const res = await request(app)
    .get('/api/audit/_ping')
    .set('Authorization', `Bearer ${revokedToken}`);
  assert.equal(res.status, 401);
});

test('POST /api/audit/_ping returns 405 (read-only)', async () => {
  const res = await request(app)
    .post('/api/audit/_ping')
    .set('Authorization', `Bearer ${validToken}`)
    .send({});
  assert.equal(res.status, 405);
});
