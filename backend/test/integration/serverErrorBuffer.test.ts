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
let householdAId: number;
let householdBId: number;

before(async () => {
  testDb = await setupPgTestDb('server-error-buffer');
  await import('../../src/models/index.js');
  app = (await import('../../src/app.js')).default;

  // Household A
  authedA = request.agent(app);
  const regA = await authedA.post('/api/auth/register').send({
    email: 'seb-a@example.com',
    displayName: 'SEB A',
    password: 'password123',
  });
  assert.equal(regA.status, 201);
  householdAId = regA.body.household?.id ?? 1;
  const mintA = await authedA.post('/api/audit/tokens').send({ label: 'A' });
  assert.equal(mintA.status, 201);
  tokenA = mintA.body.plaintext;

  // Household B
  authedB = request.agent(app);
  const regB = await authedB.post('/api/auth/register').send({
    email: 'seb-b@example.com',
    displayName: 'SEB B',
    password: 'password123',
  });
  assert.equal(regB.status, 201);
  householdBId = regB.body.household?.id ?? 2;
  const mintB = await authedB.post('/api/audit/tokens').send({ label: 'B' });
  assert.equal(mintB.status, 201);
  tokenB = mintB.body.plaintext;
});

after(async () => {
  await teardownPgTestDb(testDb);
});

test('GET /api/audit/server-errors returns expected shape', async () => {
  const res = await request(app)
    .get('/api/audit/server-errors')
    .set('Authorization', `Bearer ${tokenA}`);
  assert.equal(res.status, 200);
  assert.ok(typeof res.body.count === 'number');
  assert.ok(Array.isArray(res.body.rows));
  for (const row of res.body.rows) {
    assert.ok('id' in row);
    assert.ok('method' in row);
    assert.ok('path' in row);
    assert.ok('status' in row);
    assert.ok('message' in row);
    assert.ok('createdAt' in row);
  }
});

test('seeded ServerErrorEvent row appears in /server-errors', async () => {
  const { ServerErrorEvent } = await import('../../src/models/index.js');
  await ServerErrorEvent.create({
    householdId: householdAId,
    userId: null,
    method: 'GET',
    path: '/api/test-500',
    status: 500,
    message: 'Something went wrong in server',
    stack: 'Error: Something went wrong\n    at handler (/src/test.ts:10:1)',
    requestId: 'test-req-id-seb',
  });

  const res = await request(app)
    .get('/api/audit/server-errors')
    .set('Authorization', `Bearer ${tokenA}`);
  assert.equal(res.status, 200);
  const row = res.body.rows.find((r: { message: string }) => r.message === 'Something went wrong in server');
  assert.ok(row, 'seeded server error must appear');
  assert.equal(row.status, 500);
  assert.equal(row.method, 'GET');
});

test('?since= with a future date returns count: 0', async () => {
  const future = new Date(Date.now() + 86400000).toISOString();
  const res = await request(app)
    .get(`/api/audit/server-errors?since=${encodeURIComponent(future)}`)
    .set('Authorization', `Bearer ${tokenA}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.count, 0);
});

test('household isolation: household A does not see household B server errors', async () => {
  const { ServerErrorEvent } = await import('../../src/models/index.js');
  await ServerErrorEvent.create({
    householdId: householdBId,
    userId: null,
    method: 'POST',
    path: '/api/b-only',
    status: 500,
    message: 'B-only server error',
    stack: null,
    requestId: null,
  });

  const resA = await request(app).get('/api/audit/server-errors').set('Authorization', `Bearer ${tokenA}`);
  const resB = await request(app).get('/api/audit/server-errors').set('Authorization', `Bearer ${tokenB}`);
  assert.equal(resA.status, 200);
  assert.equal(resB.status, 200);

  const aMessages = new Set(resA.body.rows.map((r: { message: string }) => r.message));
  assert.ok(!aMessages.has('B-only server error'), 'household A must not see B errors');
  const bMessages = new Set(resB.body.rows.map((r: { message: string }) => r.message));
  assert.ok(bMessages.has('B-only server error'), 'household B must see its own errors');
});
