import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { setupPgTestDb, teardownPgTestDb, type PgTestDb } from './_setup/pgTestDb.js';

let app: import('express').Express;
let authed: ReturnType<typeof request.agent>;
let testDb: PgTestDb;
let auditToken: string;

before(async () => {
  testDb = await setupPgTestDb('audit-freshness');
  await import('../../src/models/index.js');
  app = (await import('../../src/app.js')).default;
  authed = request.agent(app);
  const register = await authed.post('/api/auth/register').send({
    email: 'audit-fresh@example.com',
    displayName: 'Fresh User',
    password: 'password123',
  });
  assert.equal(register.status, 201);

  const mint = await authed.post('/api/audit/tokens').send({ label: 'Fresh Test' });
  assert.equal(mint.status, 201);
  auditToken = mint.body.plaintext;

  // Seed a Job row so tests can assert on heartbeat fields
  const { Job } = await import('../../src/models/index.js');
  await Job.upsert({
    name: 'freshness_test_job',
    lastRunAt: new Date(),
    lastFinishedAt: new Date(),
    lastStatus: 'ok',
    lastDurationMs: 100,
    lastError: null,
    lastResultJson: null,
    enabledOverride: null,
    cronOverride: null,
  });
});

after(async () => {
  await teardownPgTestDb(testDb);
});

test('GET /api/audit/freshness returns expected top-level shape', async () => {
  const res = await request(app)
    .get('/api/audit/freshness')
    .set('Authorization', `Bearer ${auditToken}`);
  assert.equal(res.status, 200);
  const body = res.body;
  assert.ok(typeof body.generatedAt === 'string');
  assert.ok(Array.isArray(body.jobs));
  assert.ok(Array.isArray(body.imports));
  assert.ok(Array.isArray(body.emailIntegrations));
});

test('jobs contains seeded row and secondsSinceLastRun is a number', async () => {
  const res = await request(app)
    .get('/api/audit/freshness')
    .set('Authorization', `Bearer ${auditToken}`);
  assert.equal(res.status, 200);
  const seeded = res.body.jobs.find((j: { name: string }) => j.name === 'freshness_test_job');
  assert.ok(seeded, 'seeded job must appear in jobs[]');
  assert.equal(seeded.lastStatus, 'ok');
  assert.ok(typeof seeded.secondsSinceLastRun === 'number');
});

test('jobs array has correct per-row schema', async () => {
  const res = await request(app)
    .get('/api/audit/freshness')
    .set('Authorization', `Bearer ${auditToken}`);
  assert.equal(res.status, 200);
  for (const j of res.body.jobs) {
    assert.ok('name' in j);
    assert.ok('lastRunAt' in j);
    assert.ok('lastFinishedAt' in j);
    assert.ok('lastStatus' in j);
    assert.ok('lastDurationMs' in j);
    assert.ok('lastError' in j);
    assert.ok('secondsSinceLastRun' in j);
  }
});

test('jobs are ordered alphabetically by name', async () => {
  const res = await request(app)
    .get('/api/audit/freshness')
    .set('Authorization', `Bearer ${auditToken}`);
  assert.equal(res.status, 200);
  const names: string[] = res.body.jobs.map((j: { name: string }) => j.name);
  assert.deepEqual(names, [...names].sort());
});

test('imports are scoped to the callers household', async () => {
  const authedB = request.agent(app);
  const regB = await authedB.post('/api/auth/register').send({
    email: 'audit-fresh-b@example.com',
    displayName: 'Fresh B',
    password: 'password123',
  });
  assert.equal(regB.status, 201);
  const mintB = await authedB.post('/api/audit/tokens').send({ label: 'B' });
  assert.equal(mintB.status, 201);
  const tokenB = mintB.body.plaintext;

  const resA = await request(app)
    .get('/api/audit/freshness')
    .set('Authorization', `Bearer ${auditToken}`);
  const resB = await request(app)
    .get('/api/audit/freshness')
    .set('Authorization', `Bearer ${tokenB}`);
  assert.equal(resA.status, 200);
  assert.equal(resB.status, 200);

  const aIds = new Set(resA.body.imports.map((i: { id: number }) => i.id));
  for (const i of resB.body.imports) {
    assert.ok(!aIds.has(i.id), 'household B imports must not bleed into household A');
  }
});
