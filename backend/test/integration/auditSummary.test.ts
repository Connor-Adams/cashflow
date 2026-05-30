/**
 * Integration tests for /api/audit/summary (#395).
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { setupPgTestDb, teardownPgTestDb, type PgTestDb } from './_setup/pgTestDb.js';

let app: import('express').Express;
let validToken: string;
let testDb: PgTestDb;

before(async () => {
  testDb = await setupPgTestDb('audit_summary');
  process.env.DATABASE_URL = testDb.databaseUrl;
  app = (await import('../../src/app.js')).default;

  const models = await import('../../src/models/index.js');
  const { hashPassword } = await import('../../src/auth/password.js');
  const { mintAuditTokenPlaintext, hashAuditToken } = await import(
    '../../src/auth/auditToken.js'
  );
  const password = await hashPassword('password123');
  const user = await models.User.create({
    email: `audit-summary-${Date.now()}@example.com`,
    displayName: 'summary-user',
    globalRole: 'user',
    passwordHash: password.hash,
    passwordSalt: password.salt,
    passwordParams: password.params,
  });
  const household = await models.Household.create({ name: 'summary household' });
  await models.HouseholdMember.create({
    householdId: household.id,
    userId: user.id,
    role: 'owner',
  });
  validToken = mintAuditTokenPlaintext();
  await models.UserAuditToken.create({
    userId: user.id,
    tokenHash: hashAuditToken(validToken),
    label: 'summary-token',
    lastUsedAt: null,
    revokedAt: null,
  });
});

after(async () => {
  await teardownPgTestDb(testDb);
});

test('GET /api/audit/summary aggregates all probes with verdict per dimension', async () => {
  const res = await request(app)
    .get('/api/audit/summary')
    .set('Authorization', `Bearer ${validToken}`);
  assert.equal(res.status, 200);
  assert.ok(['pass', 'warn', 'fail'].includes(res.body.overall));
  for (const dim of [
    'health',
    'freshness',
    'integrity',
    'counts',
    'clientErrors',
    'serverErrors',
    'routes',
  ]) {
    assert.ok(res.body.dimensions[dim], `missing dimension: ${dim}`);
    assert.ok(
      ['pass', 'warn', 'fail'].includes(res.body.dimensions[dim].verdict),
      `invalid verdict for ${dim}: ${res.body.dimensions[dim].verdict}`,
    );
    assert.ok('summary' in res.body.dimensions[dim], `missing summary for ${dim}`);
  }
  assert.equal(typeof res.body.generatedAt, 'string');
});

test('GET /api/audit/summary?windowMinutes=5 respects window param', async () => {
  const res = await request(app)
    .get('/api/audit/summary?windowMinutes=5')
    .set('Authorization', `Bearer ${validToken}`);
  assert.equal(res.status, 200);
  assert.ok(res.body.dimensions.clientErrors.summary.includes('last 5m'));
});
