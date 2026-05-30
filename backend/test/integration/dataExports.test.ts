/**
 * Integration tests for the data export routes (issue #302):
 *   GET    /api/me/exports
 *   POST   /api/me/export
 *   GET    /api/me/export/:id
 *   GET    /api/me/export/:id/download
 *
 * Coverage (ACs from issue):
 *   #2   POST creates queued row; 201
 *   #3   Concurrent POST while one in-flight → 409 EXPORT_IN_FLIGHT
 *   #5   Ready row status on completed export
 *   #6   Download requires valid sig; 403 without it
 *   #7   Download URL exp <= expires_at
 *   #8   cleanup removes files (covered separately in unit test)
 *   #10  GET /api/me/exports lists user's exports newest-first
 *   #13  User A's export cannot be accessed by user B
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import request from 'supertest';
import path from 'path';
import os from 'os';
import { setupPgTestDb, teardownPgTestDb, type PgTestDb } from './_setup/pgTestDb.js';

// Use a temp directory for export ZIPs so tests don't pollute the project.
const tmpExportsDir = path.join(os.tmpdir(), `cashflow-test-exports-${crypto.randomBytes(4).toString('hex')}`);
process.env.EXPORTS_DIR = tmpExportsDir;
process.env.EXPORTS_URL_SECRET = 'test-secret-data-exports';
process.env.NODE_ENV = 'test';

let app: import('express').Express;
let userAAgent: ReturnType<typeof request.agent>;
let userBAgent: ReturnType<typeof request.agent>;
let userAId: number;
let userBId: number;
let testDb: PgTestDb;

type Seeded = {
  token: string;
  userId: number;
};

async function seed(emailPrefix: string): Promise<Seeded> {
  const models = await import('../../src/models/index.js');
  const { hashPassword, hashToken } = await import('../../src/auth/password.js');
  const password = await hashPassword('password123');
  const user = await models.User.create({
    email: `${emailPrefix}-${Date.now()}-${Math.random().toString(16).slice(2)}@example.com`,
    displayName: emailPrefix,
    globalRole: 'user',
    passwordHash: password.hash,
    passwordSalt: password.salt,
    passwordParams: password.params,
  });
  const household = await models.Household.create({ name: `${emailPrefix} household` });
  await models.HouseholdMember.create({
    householdId: household.id,
    userId: user.id,
    role: 'owner',
  });
  const token = crypto.randomBytes(32).toString('hex');
  await models.Session.create({
    userId: user.id,
    tokenHash: hashToken(token),
    expiresAt: new Date(Date.now() + 86400 * 1000),
  });
  return { token, userId: user.id };
}

before(async () => {
  testDb = await setupPgTestDb('data-exports');
  const mod = await import('../../src/app.js');
  app = mod.default;

  // Register as superadmin (first user)
  const bootstrap = request.agent(app);
  const reg = await bootstrap.post('/api/auth/register').send({
    email: 'admin-exports@example.com',
    displayName: 'Admin',
    password: 'password123',
  });
  assert.equal(reg.status, 201);

  const seededA = await seed('UserA');
  userAId = seededA.userId;
  userAAgent = request.agent(app);
  userAAgent.jar.setCookie(`cashflow_session=${seededA.token}; Path=/`);

  const seededB = await seed('UserB');
  userBId = seededB.userId;
  userBAgent = request.agent(app);
  userBAgent.jar.setCookie(`cashflow_session=${seededB.token}; Path=/`);
});

after(async () => {
  // Clean up temp dir
  const fs = await import('fs/promises');
  await fs.rm(tmpExportsDir, { recursive: true, force: true });
  await teardownPgTestDb(testDb);
});

// ---------------------------------------------------------------------------
// GET /api/me/exports — empty list
// ---------------------------------------------------------------------------

test('GET /api/me/exports returns empty list for new user (AC #10)', async () => {
  const r = await userAAgent.get('/api/me/exports');
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.body.data));
  assert.equal(r.body.data.length, 0);
});

// ---------------------------------------------------------------------------
// POST /api/me/export — create export (AC #2)
// ---------------------------------------------------------------------------

test('POST /api/me/export creates a queued row and returns 201 (AC #2)', async () => {
  const r = await userAAgent.post('/api/me/export').send({});
  assert.equal(r.status, 201);
  assert.ok(r.body.exportId, 'should return exportId');
  assert.equal(r.body.status, 'queued');
});

// ---------------------------------------------------------------------------
// 409 on concurrent export (AC #3)
// ---------------------------------------------------------------------------

test('POST /api/me/export while one is in-flight returns 409 (AC #3)', async () => {
  // Manually set the existing export to 'running' to simulate in-flight state
  const models = await import('../../src/models/index.js');
  const exports = await models.DataExport.findAll({
    where: { userId: userAId },
    order: [['id', 'DESC']],
    limit: 1,
  });
  assert.ok(exports.length > 0, 'UserA should have at least one export');
  await exports[0].update({ status: 'running' });

  const r = await userAAgent.post('/api/me/export').send({});
  assert.equal(r.status, 409);
  assert.equal(r.body.error, 'EXPORT_IN_FLIGHT');
  assert.ok(r.body.message, 'should include a human-readable message');

  // Reset back to queued so later tests pass
  await exports[0].update({ status: 'queued' });
});

// ---------------------------------------------------------------------------
// GET /api/me/export/:id — status of one export
// ---------------------------------------------------------------------------

test('GET /api/me/export/:id returns the export row', async () => {
  const models = await import('../../src/models/index.js');
  const [exp] = await models.DataExport.findAll({
    where: { userId: userAId },
    order: [['id', 'DESC']],
    limit: 1,
  });
  assert.ok(exp, 'UserA should have an export');

  const r = await userAAgent.get(`/api/me/export/${exp.id}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.id, exp.id);
  assert.ok(r.body.status, 'should include status');
  assert.ok(r.body.requestedAt, 'should include requestedAt');
});

test('GET /api/me/export/:id returns 404 for another user export (AC #13)', async () => {
  const models = await import('../../src/models/index.js');
  const [expA] = await models.DataExport.findAll({
    where: { userId: userAId },
    order: [['id', 'DESC']],
    limit: 1,
  });
  assert.ok(expA, 'UserA should have an export');

  // UserB tries to access UserA's export
  const r = await userBAgent.get(`/api/me/export/${expA.id}`);
  assert.equal(r.status, 404);
});

// ---------------------------------------------------------------------------
// GET /api/me/export/:id/download — signature enforcement (AC #6)
// ---------------------------------------------------------------------------

test('GET /api/me/export/:id/download without sig returns 403', async () => {
  const models = await import('../../src/models/index.js');
  const [exp] = await models.DataExport.findAll({
    where: { userId: userAId },
    order: [['id', 'DESC']],
    limit: 1,
  });
  assert.ok(exp);

  const r = await userAAgent.get(`/api/me/export/${exp.id}/download`);
  assert.equal(r.status, 403);
});

test('GET /api/me/export/:id/download with invalid sig returns 403', async () => {
  const models = await import('../../src/models/index.js');
  const [exp] = await models.DataExport.findAll({
    where: { userId: userAId },
    order: [['id', 'DESC']],
    limit: 1,
  });
  assert.ok(exp);
  const futureExp = Math.floor(Date.now() / 1000) + 3600;
  const r = await userAAgent.get(
    `/api/me/export/${exp.id}/download?exp=${futureExp}&sig=badbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbad1234`,
  );
  assert.equal(r.status, 403);
});

// ---------------------------------------------------------------------------
// Full lifecycle — simulate ready export, test download URL
// ---------------------------------------------------------------------------

test('ready export has a downloadUrl with valid sig (AC #5, #6, #7)', async () => {
  const models = await import('../../src/models/index.js');
  const fs = await import('fs/promises');

  // Create UserB's export and manually mark it ready (simulates job completion)
  const exp = await models.DataExport.create({
    userId: userBId,
    status: 'queued',
    readyAt: null,
    expiresAt: null,
    storageKey: null,
    byteSize: null,
    errorMessage: null,
  });

  // Create a dummy ZIP file on disk
  const userBDir = `${tmpExportsDir}/${userBId}`;
  await fs.mkdir(userBDir, { recursive: true });
  const fakeZipPath = `${userBDir}/export-${exp.id}.zip`;
  await fs.writeFile(fakeZipPath, Buffer.from('PK dummy'));
  const fakeStat = await fs.stat(fakeZipPath);

  const now = new Date();
  const expiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
  await exp.update({
    status: 'ready',
    storageKey: `${userBId}/export-${exp.id}.zip`,
    byteSize: fakeStat.size,
    readyAt: now,
    expiresAt,
  });

  // GET /api/me/exports should include downloadUrl
  const listR = await userBAgent.get('/api/me/exports');
  assert.equal(listR.status, 200);
  const readyRow = listR.body.data.find((e: { id: number }) => e.id === exp.id);
  assert.ok(readyRow, 'ready export should be in list');
  assert.ok(readyRow.downloadUrl, 'ready export should have downloadUrl');

  // exp param should be <= expiresAt (AC #7)
  const urlParams = new URL(`http://x${readyRow.downloadUrl}`).searchParams;
  const expSec = Number(urlParams.get('exp'));
  assert.ok(expSec > 0, 'exp param should be set');
  assert.ok(expSec <= Math.floor(expiresAt.getTime() / 1000), 'exp must be <= expiresAt');

  // Download should succeed with valid URL
  const downloadR = await userBAgent.get(readyRow.downloadUrl);
  assert.equal(downloadR.status, 200);
  assert.ok(downloadR.headers['content-type']?.includes('zip'), 'should be a zip');
});

// ---------------------------------------------------------------------------
// Expired export → 410 (AC #7)
// ---------------------------------------------------------------------------

test('GET /api/me/export/:id/download with expired sig returns 410', async () => {
  const { buildSignedParams } = await import('../../src/services/signedUrl.js');
  const models = await import('../../src/models/index.js');

  // Create a "ready" export that expires in 1ms
  const exp = await models.DataExport.create({
    userId: userBId,
    status: 'ready',
    storageKey: `${userBId}/fake-expired.zip`,
    byteSize: 100,
    readyAt: new Date(),
    expiresAt: new Date(Date.now() - 1000), // already expired
    errorMessage: null,
  });

  // Build params with an exp that is in the past
  const expiredAt = new Date(Date.now() - 5000);
  const params = buildSignedParams(exp.id, userBId, expiredAt);
  const r = await userBAgent.get(
    `/api/me/export/${exp.id}/download?exp=${params.exp}&sig=${params.sig}`,
  );
  assert.equal(r.status, 410);
  assert.equal(r.body.error, 'EXPORT_EXPIRED');
});

// ---------------------------------------------------------------------------
// List isolates by user (AC #13)
// ---------------------------------------------------------------------------

test('GET /api/me/exports only returns own exports (AC #13)', async () => {
  const models = await import('../../src/models/index.js');

  // UserA's exports count
  const listA = await userAAgent.get('/api/me/exports');
  assert.equal(listA.status, 200);
  const aIds = new Set((listA.body.data as Array<{ id: number }>).map((e) => e.id));

  // UserB's exports count
  const listB = await userBAgent.get('/api/me/exports');
  assert.equal(listB.status, 200);
  const bIds = new Set((listB.body.data as Array<{ id: number }>).map((e) => e.id));

  // No overlap
  for (const id of aIds) {
    assert.ok(!bIds.has(id), `Export ${id} should not appear in UserB's list`);
  }

  // All A exports belong to A
  const allAExports = await models.DataExport.findAll({
    where: { userId: userAId },
    attributes: ['id'],
  });
  for (const e of allAExports) {
    assert.ok(aIds.has(e.id), `UserA export ${e.id} missing from list`);
  }
});

// ---------------------------------------------------------------------------
// Unauthenticated requests are rejected
// ---------------------------------------------------------------------------

test('GET /api/me/exports returns 401 without auth', async () => {
  const r = await request(app).get('/api/me/exports');
  assert.equal(r.status, 401);
});

test('POST /api/me/export returns 401 without auth', async () => {
  const r = await request(app).post('/api/me/export').send({});
  assert.equal(r.status, 401);
});
