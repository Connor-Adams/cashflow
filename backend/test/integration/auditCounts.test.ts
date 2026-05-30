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
  testDb = await setupPgTestDb('audit-counts');
  await import('../../src/models/index.js');
  app = (await import('../../src/app.js')).default;

  // Household A
  authedA = request.agent(app);
  const regA = await authedA.post('/api/auth/register').send({
    email: 'audit-counts-a@example.com',
    displayName: 'Audit Counts A',
    password: 'password123',
  });
  assert.equal(regA.status, 201);
  const mintA = await authedA.post('/api/audit/tokens').send({ label: 'Test' });
  assert.equal(mintA.status, 201);
  tokenA = mintA.body.plaintext;

  // Create some accounts in household A
  await authedA.post('/api/accounts').send({ name: 'Chequing', accountType: 'checking' });
  await authedA.post('/api/accounts').send({ name: 'Savings', accountType: 'savings' });

  // Household B
  authedB = request.agent(app);
  const regB = await authedB.post('/api/auth/register').send({
    email: 'audit-counts-b@example.com',
    displayName: 'Audit Counts B',
    password: 'password123',
  });
  assert.equal(regB.status, 201);
  const mintB = await authedB.post('/api/audit/tokens').send({ label: 'Test' });
  assert.equal(mintB.status, 201);
  tokenB = mintB.body.plaintext;

  // Create 5 accounts in household B
  for (let i = 0; i < 5; i++) {
    await authedB.post('/api/accounts').send({ name: `B Account ${i}`, accountType: 'checking' });
  }
});

after(async () => {
  await teardownPgTestDb(testDb);
});

test('GET /api/audit/counts returns all canonical keys as numbers', async () => {
  const res = await request(app)
    .get('/api/audit/counts')
    .set('Authorization', `Bearer ${tokenA}`);
  assert.equal(res.status, 200);
  const body = res.body;
  assert.ok(typeof body.generatedAt === 'string');
  const counts = body.counts;
  const CANONICAL_KEYS = [
    'transactions', 'accounts', 'holdings', 'rules', 'contacts',
    'externalOrders', 'subscriptions', 'goals', 'budgets',
    'auditLog', 'chatThreads', 'aiSuggestions',
  ];
  for (const key of CANONICAL_KEYS) {
    assert.ok(key in counts, `key ${key} should be present`);
    assert.ok(typeof counts[key] === 'number', `counts.${key} should be a number`);
  }
});

test('counts reflect seeded accounts', async () => {
  const res = await request(app)
    .get('/api/audit/counts')
    .set('Authorization', `Bearer ${tokenA}`);
  assert.equal(res.status, 200);
  assert.ok(res.body.counts.accounts >= 2, 'household A should have at least 2 accounts');
});

test('household isolation: household A counts do not include household B rows', async () => {
  const resA = await request(app)
    .get('/api/audit/counts')
    .set('Authorization', `Bearer ${tokenA}`);
  const resB = await request(app)
    .get('/api/audit/counts')
    .set('Authorization', `Bearer ${tokenB}`);
  assert.equal(resA.status, 200);
  assert.equal(resB.status, 200);
  // household B has 5 accounts, household A has 2 — they must not bleed
  assert.ok(resA.body.counts.accounts < resB.body.counts.accounts,
    'household A (2 accounts) should have fewer than household B (5 accounts)');
});

test('GET /api/audit/counts returns 401 without bearer', async () => {
  const res = await request(app).get('/api/audit/counts');
  assert.equal(res.status, 401);
});
