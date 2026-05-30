import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { setupPgTestDb, teardownPgTestDb, type PgTestDb } from './_setup/pgTestDb.js';

let app: import('express').Express;
let authed: ReturnType<typeof request.agent>;
let testDb: PgTestDb;
let captureToken: string;
let auditToken: string;
let reportingToken: string;

before(async () => {
  testDb = await setupPgTestDb('reporting-middleware');
  await import('../../src/models/index.js');
  app = (await import('../../src/app.js')).default;
  authed = request.agent(app);
  const register = await authed.post('/api/auth/register').send({
    email: 'reporting-mw@example.com',
    displayName: 'Reporting MW User',
    password: 'password123',
  });
  assert.equal(register.status, 201);

  const mintReporting = await authed.post('/api/v1/tokens').send({ label: 'Test' });
  assert.equal(mintReporting.status, 201);
  reportingToken = mintReporting.body.plaintext;

  const mintCapture = await authed.post('/api/capture/tokens').send({ label: 'Import' });
  assert.equal(mintCapture.status, 201);
  captureToken = mintCapture.body.plaintext;

  const mintAudit = await authed.post('/api/audit/tokens').send({ label: 'Audit' });
  assert.equal(mintAudit.status, 201);
  auditToken = mintAudit.body.plaintext;
});

after(async () => {
  await teardownPgTestDb(testDb);
});

test('summary succeeds with valid cfr_ bearer', async () => {
  const res = await request(app)
    .get('/api/v1/summary')
    .set('Authorization', `Bearer ${reportingToken}`);
  assert.equal(res.status, 200);
  assert.ok('asOf' in res.body);
  assert.ok('netWorth' in res.body);
  assert.ok('monthlyBurn' in res.body);
});

test('summary returns 401 without Authorization', async () => {
  const res = await request(app).get('/api/v1/summary');
  assert.equal(res.status, 401);
  assert.equal(res.body.error, 'Invalid reporting token');
});

test('summary returns 401 with a cfc_ token', async () => {
  const res = await request(app)
    .get('/api/v1/summary')
    .set('Authorization', `Bearer ${captureToken}`);
  assert.equal(res.status, 401);
  assert.equal(res.body.error, 'Invalid reporting token');
});

test('summary returns 401 with a cfa_ token', async () => {
  const res = await request(app)
    .get('/api/v1/summary')
    .set('Authorization', `Bearer ${auditToken}`);
  assert.equal(res.status, 401);
  assert.equal(res.body.error, 'Invalid reporting token');
});

test('summary returns 401 for revoked token', async () => {
  const mint = await authed.post('/api/v1/tokens').send({ label: 'Revoke Me' });
  assert.equal(mint.status, 201);
  const revokeToken = mint.body.plaintext;
  const tokenId = mint.body.id;

  await authed.delete(`/api/v1/tokens/${tokenId}`);

  const res = await request(app)
    .get('/api/v1/summary')
    .set('Authorization', `Bearer ${revokeToken}`);
  assert.equal(res.status, 401);
});

test('POST to /api/v1/summary returns 405', async () => {
  const res = await request(app)
    .post('/api/v1/summary')
    .set('Authorization', `Bearer ${reportingToken}`);
  assert.equal(res.status, 405);
  assert.equal(res.body.error, 'Reporting tokens are read-only');
});

test('last_used_at is bumped after successful auth', async () => {
  const { hashReportingToken } = await import('../../src/auth/reportingToken.js');
  const models = await import('../../src/models/index.js');
  const before_ = await models.UserReportingToken.findOne({
    where: { tokenHash: hashReportingToken(reportingToken) },
  });
  const beforeTs = before_?.lastUsedAt ?? null;

  await request(app)
    .get('/api/v1/summary')
    .set('Authorization', `Bearer ${reportingToken}`);

  await new Promise((r) => setTimeout(r, 100));

  const after_ = await models.UserReportingToken.findOne({
    where: { tokenHash: hashReportingToken(reportingToken) },
  });
  assert.ok(after_?.lastUsedAt != null, 'lastUsedAt should be set');
  if (beforeTs != null) {
    assert.ok(
      after_!.lastUsedAt!.getTime() >= beforeTs.getTime(),
      'lastUsedAt should be >= previous value',
    );
  }
});
