/**
 * Integration tests for /api/audit/route-probe (#394).
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { setupPgTestDb, teardownPgTestDb, type PgTestDb } from './_setup/pgTestDb.js';

let app: import('express').Express;
let validToken: string;
let testDb: PgTestDb;

before(async () => {
  testDb = await setupPgTestDb('audit_route_probe');
  process.env.DATABASE_URL = testDb.databaseUrl;
  app = (await import('../../src/app.js')).default;

  const models = await import('../../src/models/index.js');
  const { hashPassword } = await import('../../src/auth/password.js');
  const { mintAuditTokenPlaintext, hashAuditToken } = await import(
    '../../src/auth/auditToken.js'
  );
  const password = await hashPassword('password123');
  const user = await models.User.create({
    email: `route-probe-${Date.now()}@example.com`,
    displayName: 'probe-user',
    globalRole: 'user',
    passwordHash: password.hash,
    passwordSalt: password.salt,
    passwordParams: password.params,
  });
  const household = await models.Household.create({ name: 'probe household' });
  await models.HouseholdMember.create({
    householdId: household.id,
    userId: user.id,
    role: 'owner',
  });
  validToken = mintAuditTokenPlaintext();
  await models.UserAuditToken.create({
    userId: user.id,
    tokenHash: hashAuditToken(validToken),
    label: 'probe-token',
    lastUsedAt: null,
    revokedAt: null,
  });
});

after(async () => {
  await teardownPgTestDb(testDb);
});

test('GET /api/audit/route-probe returns per-page status for every manifested route', async () => {
  const res = await request(app)
    .get('/api/audit/route-probe')
    .set('Authorization', `Bearer ${validToken}`);
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.routes));
  assert.ok(res.body.routes.length >= 5);
  for (const r of res.body.routes) {
    assert.equal(typeof r.page, 'string');
    assert.ok(Array.isArray(r.apis));
    assert.equal(typeof r.ok, 'boolean');
    for (const a of r.apis) {
      assert.equal(typeof a.path, 'string');
      assert.equal(typeof a.status, 'number');
      assert.equal(typeof a.ok, 'boolean');
    }
  }
  assert.equal(typeof res.body.generatedAt, 'string');
});
