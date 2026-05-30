import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { setupPgTestDb, teardownPgTestDb, type PgTestDb } from './_setup/pgTestDb.js';

let app: import('express').Express;
let authed: ReturnType<typeof request.agent>;
let authedB: ReturnType<typeof request.agent>;
let testDb: PgTestDb;
let tokenA: string;
let tokenB: string;
let accountId: number;

before(async () => {
  testDb = await setupPgTestDb('reporting-endpoints');
  await import('../../src/models/index.js');
  app = (await import('../../src/app.js')).default;

  // Household A
  authed = request.agent(app);
  const regA = await authed.post('/api/auth/register').send({
    email: 'rep-endpoints-a@example.com',
    displayName: 'Rep A',
    password: 'password123',
  });
  assert.equal(regA.status, 201);
  const mintA = await authed.post('/api/v1/tokens').send({ label: 'A' });
  assert.equal(mintA.status, 201);
  tokenA = mintA.body.plaintext;

  // Create an account and some transactions for household A
  const accRes = await authed.post('/api/accounts').send({ name: 'Chequing', accountType: 'checking', defaultCurrency: 'CAD' });
  assert.equal(accRes.status, 201);
  accountId = accRes.body.id;

  // Household B (isolation checks)
  authedB = request.agent(app);
  const regB = await authedB.post('/api/auth/register').send({
    email: 'rep-endpoints-b@example.com',
    displayName: 'Rep B',
    password: 'password123',
  });
  assert.equal(regB.status, 201);
  const mintB = await authedB.post('/api/v1/tokens').send({ label: 'B' });
  assert.equal(mintB.status, 201);
  tokenB = mintB.body.plaintext;
  // Create 3 accounts in household B
  for (let i = 0; i < 3; i++) {
    await authedB.post('/api/accounts').send({ name: `B Acc ${i}`, accountType: 'checking' });
  }
});

after(async () => {
  await teardownPgTestDb(testDb);
});

// ── /net-worth ────────────────────────────────────────────────────────────────

test('GET /api/v1/net-worth returns range and points', async () => {
  const res = await request(app)
    .get('/api/v1/net-worth')
    .set('Authorization', `Bearer ${tokenA}`);
  assert.equal(res.status, 200);
  assert.ok('range' in res.body);
  assert.ok('points' in res.body);
  assert.ok(Array.isArray(res.body.points));
  if (res.body.points.length > 0) {
    const p = res.body.points[0];
    assert.ok('date' in p);
    assert.ok('assets' in p);
    assert.ok('liabilities' in p);
    assert.ok('netWorth' in p);
  }
});

test('GET /api/v1/net-worth?interval=week returns weekly buckets', async () => {
  const res = await request(app)
    .get(`/api/v1/net-worth?start=2025-01-01&end=2025-01-31&interval=week`)
    .set('Authorization', `Bearer ${tokenA}`);
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.points));
});

test('GET /api/v1/net-worth?interval=bad returns 400', async () => {
  const res = await request(app)
    .get('/api/v1/net-worth?interval=bad')
    .set('Authorization', `Bearer ${tokenA}`);
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'interval must be day|week|month');
});

// ── /accounts ────────────────────────────────────────────────────────────────

test('GET /api/v1/accounts returns accounts array', async () => {
  const res = await request(app)
    .get('/api/v1/accounts')
    .set('Authorization', `Bearer ${tokenA}`);
  assert.equal(res.status, 200);
  assert.ok('accounts' in res.body);
  assert.ok(Array.isArray(res.body.accounts));
  if (res.body.accounts.length > 0) {
    const a = res.body.accounts[0];
    assert.ok('id' in a);
    assert.ok('name' in a);
    assert.ok('type' in a);
    assert.ok('currency' in a);
    assert.ok(typeof a.balance === 'number');
  }
});

test('GET /api/v1/accounts: household isolation — household A does not see household B accounts', async () => {
  const resA = await request(app).get('/api/v1/accounts').set('Authorization', `Bearer ${tokenA}`);
  const resB = await request(app).get('/api/v1/accounts').set('Authorization', `Bearer ${tokenB}`);
  assert.equal(resA.status, 200);
  assert.equal(resB.status, 200);
  // Household B has 3 accounts, household A has 1
  assert.ok(resA.body.accounts.length < resB.body.accounts.length);
  // No account from household B appears in household A's list
  const bIds = new Set(resB.body.accounts.map((a: { id: number }) => a.id));
  for (const a of resA.body.accounts) {
    assert.ok(!bIds.has(a.id), 'household A should not see household B accounts');
  }
});

test('GET /api/v1/accounts for empty household returns empty array', async () => {
  const emptyAgent = request.agent(app);
  const reg = await emptyAgent.post('/api/auth/register').send({
    email: 'rep-empty@example.com',
    displayName: 'Empty',
    password: 'password123',
  });
  assert.equal(reg.status, 201);
  const mint = await emptyAgent.post('/api/v1/tokens').send({ label: 'E' });
  const emptyToken = mint.body.plaintext;
  const res = await request(app).get('/api/v1/accounts').set('Authorization', `Bearer ${emptyToken}`);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.accounts, []);
});

// ── /cashflow/monthly ─────────────────────────────────────────────────────────

test('GET /api/v1/cashflow/monthly returns months array', async () => {
  const res = await request(app)
    .get('/api/v1/cashflow/monthly')
    .set('Authorization', `Bearer ${tokenA}`);
  assert.equal(res.status, 200);
  assert.ok('months' in res.body);
  assert.ok(Array.isArray(res.body.months));
  for (const m of res.body.months) {
    assert.ok('month' in m);
    assert.ok(typeof m.income === 'number');
    assert.ok(typeof m.expenses === 'number');
    assert.ok(typeof m.netCashflow === 'number');
    assert.ok(typeof m.savingsRate === 'number');
    assert.ok(typeof m.recurringExpenses === 'number');
    assert.ok(typeof m.variableExpenses === 'number');
    // recurringExpenses + variableExpenses == expenses
    assert.ok(
      Math.abs(m.recurringExpenses + m.variableExpenses - m.expenses) < 0.01,
      `${m.recurringExpenses} + ${m.variableExpenses} should == ${m.expenses}`,
    );
  }
});

// ── /transactions ─────────────────────────────────────────────────────────────

test('GET /api/v1/transactions returns transactions array', async () => {
  const res = await request(app)
    .get('/api/v1/transactions')
    .set('Authorization', `Bearer ${tokenA}`);
  assert.equal(res.status, 200);
  assert.ok('transactions' in res.body);
  assert.ok(Array.isArray(res.body.transactions));
});

test('GET /api/v1/transactions pagination with cursor', async () => {
  // Seed some transactions
  const { Transaction: TxnModel, Account: AccModel } = await import('../../src/models/index.js');
  const acc = await AccModel.findByPk(accountId);
  if (acc) {
    for (let i = 0; i < 5; i++) {
      await TxnModel.create({
        accountId,
        householdId: acc.householdId,
        date: `2025-0${i + 1}-15`,
        amount: -(100 + i),
        currency: 'CAD',
        merchantRaw: `Merchant ${i}`,
        merchantClean: `Merchant ${i}`,
        importBatch: `batch-rep-${i}`,
        sourceRowFingerprint: `rfp-rep-${i}`,
        sourceIdentityFingerprint: `ifp-rep-${i}`,
        finalSplitType: 'all_mine',
        finalBusiness: false,
        reviewFlag: false,
        txnType: 'purchase',
      });
    }
  }

  const page1 = await request(app)
    .get('/api/v1/transactions?limit=2')
    .set('Authorization', `Bearer ${tokenA}`);
  assert.equal(page1.status, 200);
  assert.ok(page1.body.transactions.length <= 2);
  if (page1.body.nextCursor) {
    const page2 = await request(app)
      .get(`/api/v1/transactions?limit=2&cursor=${page1.body.nextCursor}`)
      .set('Authorization', `Bearer ${tokenA}`);
    assert.equal(page2.status, 200);
    assert.ok(Array.isArray(page2.body.transactions));
  }
});

test('GET /api/v1/transactions with malformed cursor returns 400', async () => {
  const res = await request(app)
    .get('/api/v1/transactions?cursor=!!!notbase64')
    .set('Authorization', `Bearer ${tokenA}`);
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'Invalid cursor');
});

test('GET /api/v1/transactions limit=9999 is clamped to 200', async () => {
  const res = await request(app)
    .get('/api/v1/transactions?limit=9999')
    .set('Authorization', `Bearer ${tokenA}`);
  assert.equal(res.status, 200);
  assert.ok(res.body.transactions.length <= 200);
});

// ── /projections ──────────────────────────────────────────────────────────────

test('GET /api/v1/projections returns assumptions and projections', async () => {
  const res = await request(app)
    .get('/api/v1/projections')
    .set('Authorization', `Bearer ${tokenA}`);
  assert.equal(res.status, 200);
  const { assumptions, projections } = res.body;
  assert.ok(typeof assumptions.monthlyIncome === 'number');
  assert.ok(typeof assumptions.monthlyExpenses === 'number');
  assert.ok(typeof assumptions.investmentGrowthRate === 'number');
  assert.ok(typeof assumptions.taxRate === 'number');
  assert.ok(Array.isArray(projections));
  for (const p of projections) {
    assert.ok('date' in p);
    assert.ok(typeof p.projectedCash === 'number');
    assert.ok(typeof p.projectedInvestments === 'number');
    assert.ok(typeof p.projectedNetWorth === 'number');
    // identity: projectedNetWorth == projectedCash + projectedInvestments - liabilities
    // (liabilities=0 in this test since no loan accounts)
    assert.ok(
      Math.abs(p.projectedNetWorth - (p.projectedCash + p.projectedInvestments)) < 0.01,
    );
  }
});

// ── Auth (inherited) ──────────────────────────────────────────────────────────

test('all endpoints return 401 with no bearer', async () => {
  const endpoints = ['/api/v1/net-worth', '/api/v1/accounts', '/api/v1/cashflow/monthly', '/api/v1/transactions', '/api/v1/projections'];
  for (const ep of endpoints) {
    const res = await request(app).get(ep);
    assert.equal(res.status, 401, `${ep} should return 401 without bearer`);
  }
});

test('all endpoints return 401 with cfc_ token', async () => {
  const cfc = await authed.post('/api/capture/tokens').send({ label: 'X' });
  const cfcToken = cfc.body.plaintext;
  const endpoints = ['/api/v1/net-worth', '/api/v1/accounts', '/api/v1/cashflow/monthly', '/api/v1/transactions', '/api/v1/projections'];
  for (const ep of endpoints) {
    const res = await request(app).get(ep).set('Authorization', `Bearer ${cfcToken}`);
    assert.equal(res.status, 401, `${ep} should reject cfc_ token`);
  }
});
