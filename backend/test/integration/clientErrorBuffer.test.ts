import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { setupPgTestDb, teardownPgTestDb, type PgTestDb } from './_setup/pgTestDb.js';

let app: import('express').Express;
let authedA: ReturnType<typeof request.agent>;
let authedB: ReturnType<typeof request.agent>;
let testDb: PgTestDb;
let tokenA: string;
let tokenB: string;

before(async () => {
  testDb = await setupPgTestDb('client-error-buffer');
  await import('../../src/models/index.js');
  app = (await import('../../src/app.js')).default;

  // Household A
  authedA = request.agent(app);
  const regA = await authedA.post('/api/auth/register').send({
    email: 'ceb-a@example.com',
    displayName: 'CEB A',
    password: 'password123',
  });
  assert.equal(regA.status, 201);
  const mintA = await authedA.post('/api/audit/tokens').send({ label: 'A' });
  assert.equal(mintA.status, 201);
  tokenA = mintA.body.plaintext;

  // Household B
  authedB = request.agent(app);
  const regB = await authedB.post('/api/auth/register').send({
    email: 'ceb-b@example.com',
    displayName: 'CEB B',
    password: 'password123',
  });
  assert.equal(regB.status, 201);
  const mintB = await authedB.post('/api/audit/tokens').send({ label: 'B' });
  assert.equal(mintB.status, 201);
  tokenB = mintB.body.plaintext;
});

after(async () => {
  await teardownPgTestDb(testDb);
});

test('POST /api/client-logs with level=error persists a row', async () => {
  const post = await authedA.post('/api/client-logs').send({
    level: 'error',
    event: 'page.crash',
    message: 'TypeError: Cannot read properties of undefined',
    path: '/transactions',
  });
  assert.equal(post.status, 204);

  // Short wait for the best-effort async insert
  await new Promise((r) => setTimeout(r, 100));

  const res = await request(app)
    .get('/api/audit/client-errors')
    .set('Authorization', `Bearer ${tokenA}`);
  assert.equal(res.status, 200);
  assert.ok(res.body.count >= 1);
  const row = res.body.rows.find((r: { event: string }) => r.event === 'page.crash');
  assert.ok(row, 'persisted row must appear');
  assert.equal(row.level, 'error');
  assert.equal(row.message, 'TypeError: Cannot read properties of undefined');
  assert.equal(row.path, '/transactions');
});

test('POST /api/client-logs with level=info does NOT persist', async () => {
  const { ClientErrorEvent } = await import('../../src/models/index.js');
  const countBefore = await ClientErrorEvent.count();
  await authedA.post('/api/client-logs').send({
    level: 'info',
    event: 'page.view',
    message: 'User navigated',
  });
  await new Promise((r) => setTimeout(r, 100));
  const countAfter = await ClientErrorEvent.count();
  assert.equal(countBefore, countAfter, 'info-level logs must not persist');
});

test('GET /api/audit/client-errors returns expected shape', async () => {
  const res = await request(app)
    .get('/api/audit/client-errors')
    .set('Authorization', `Bearer ${tokenA}`);
  assert.equal(res.status, 200);
  assert.ok(typeof res.body.count === 'number');
  assert.ok(Array.isArray(res.body.rows));
  for (const row of res.body.rows) {
    assert.ok('id' in row);
    assert.ok('level' in row);
    assert.ok('message' in row);
    assert.ok('createdAt' in row);
  }
});

test('?since= with a future date returns count: 0', async () => {
  const future = new Date(Date.now() + 86400000).toISOString();
  const res = await request(app)
    .get(`/api/audit/client-errors?since=${encodeURIComponent(future)}`)
    .set('Authorization', `Bearer ${tokenA}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.count, 0);
});

test('?level=warn excludes error-level rows', async () => {
  // Seed a warn row
  await authedA.post('/api/client-logs').send({
    level: 'warn',
    event: 'slow.render',
    message: 'Render took too long',
  });
  await new Promise((r) => setTimeout(r, 100));

  const res = await request(app)
    .get('/api/audit/client-errors?level=warn')
    .set('Authorization', `Bearer ${tokenA}`);
  assert.equal(res.status, 200);
  for (const row of res.body.rows) {
    assert.equal(row.level, 'warn', 'only warn rows should be returned');
  }
});

test('household isolation: household A does not see household B errors', async () => {
  // Seed an error for household B
  await authedB.post('/api/client-logs').send({
    level: 'error',
    event: 'b.crash',
    message: 'B-only error',
  });
  await new Promise((r) => setTimeout(r, 100));

  const resA = await request(app).get('/api/audit/client-errors').set('Authorization', `Bearer ${tokenA}`);
  const resB = await request(app).get('/api/audit/client-errors').set('Authorization', `Bearer ${tokenB}`);
  assert.equal(resA.status, 200);
  assert.equal(resB.status, 200);

  const aEvents = new Set(resA.body.rows.map((r: { event: string }) => r.event));
  assert.ok(!aEvents.has('b.crash'), 'household A must not see B crash');
  const bEvents = new Set(resB.body.rows.map((r: { event: string }) => r.event));
  assert.ok(bEvents.has('b.crash'), 'household B must see its own crash');
});
