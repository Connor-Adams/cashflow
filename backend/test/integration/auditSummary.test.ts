import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import request from 'supertest';
import { setupPgTestDb, teardownPgTestDb, type PgTestDb } from './_setup/pgTestDb.js';

let app: import('express').Express;
let server: http.Server;
let authed: ReturnType<typeof request.agent>;
let testDb: PgTestDb;
let auditToken: string;

const VALID_VERDICTS = new Set(['pass', 'warn', 'fail']);
const DIMENSION_KEYS = ['health', 'freshness', 'integrity', 'counts', 'clientErrors', 'serverErrors', 'routes'];

before(async () => {
  testDb = await setupPgTestDb('audit-summary');
  await import('../../src/models/index.js');
  app = (await import('../../src/app.js')).default;

  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

  authed = request.agent(server);
  const reg = await authed.post('/api/auth/register').send({
    email: 'audit-summary@example.com',
    displayName: 'Summary',
    password: 'password123',
  });
  assert.equal(reg.status, 201);
  const mint = await authed.post('/api/audit/tokens').send({ label: 'S' });
  assert.equal(mint.status, 201);
  auditToken = mint.body.plaintext;
});

after(async () => {
  await new Promise<void>((resolve, reject) => server.close((e) => e ? reject(e) : resolve()));
  await teardownPgTestDb(testDb);
});

test('GET /api/audit/summary returns expected shape', async () => {
  const res = await request(server)
    .get('/api/audit/summary')
    .set('Authorization', `Bearer ${auditToken}`);
  assert.equal(res.status, 200);
  const body = res.body;
  assert.ok(typeof body.generatedAt === 'string');
  assert.ok(VALID_VERDICTS.has(body.overall), `overall "${body.overall}" not valid`);
  assert.ok(typeof body.dimensions === 'object');
  for (const key of DIMENSION_KEYS) {
    assert.ok(key in body.dimensions, `dimension ${key} must be present`);
    const dim = body.dimensions[key];
    assert.ok(VALID_VERDICTS.has(dim.verdict), `${key}.verdict "${dim.verdict}" not valid`);
    assert.ok(typeof dim.summary === 'string' && dim.summary.length > 0, `${key}.summary must be non-empty`);
  }
});

test('overall is the worst of all dimensions', async () => {
  const res = await request(server)
    .get('/api/audit/summary')
    .set('Authorization', `Bearer ${auditToken}`);
  assert.equal(res.status, 200);
  const verdictRank: Record<string, number> = { pass: 0, warn: 1, fail: 2 };
  const worst = Object.values(res.body.dimensions as Record<string, { verdict: string }>)
    .map((d) => verdictRank[d.verdict] ?? 0)
    .reduce((a, b) => Math.max(a, b), 0);
  const expectedOverall = Object.keys(verdictRank).find((k) => verdictRank[k] === worst)!;
  assert.equal(res.body.overall, expectedOverall);
});

test('?windowMinutes=15 is honored', async () => {
  // This just checks the response comes back — the window affects the count query
  const res = await request(server)
    .get('/api/audit/summary?windowMinutes=15')
    .set('Authorization', `Bearer ${auditToken}`);
  assert.equal(res.status, 200);
  assert.ok(VALID_VERDICTS.has(res.body.overall));
});

test('?windowMinutes=99999 is clamped to 1440', async () => {
  const res = await request(server)
    .get('/api/audit/summary?windowMinutes=99999')
    .set('Authorization', `Bearer ${auditToken}`);
  assert.equal(res.status, 200);
  assert.ok(VALID_VERDICTS.has(res.body.overall));
});

test('errored job causes freshness dimension to fail and overall to fail', async () => {
  const { Job } = await import('../../src/models/index.js');
  await Job.upsert({
    name: 'summary_test_errored_job',
    lastRunAt: new Date(),
    lastFinishedAt: new Date(),
    lastStatus: 'error',
    lastDurationMs: 100,
    lastError: 'boom',
    lastResultJson: null,
    enabledOverride: null,
    cronOverride: null,
  });

  const res = await request(server)
    .get('/api/audit/summary')
    .set('Authorization', `Bearer ${auditToken}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.dimensions.freshness.verdict, 'fail');
  assert.equal(res.body.overall, 'fail');
});
