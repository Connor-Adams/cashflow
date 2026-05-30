import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { setupPgTestDb, teardownPgTestDb, type PgTestDb } from './_setup/pgTestDb.js';

let app: import('express').Express;
let authed: ReturnType<typeof request.agent>;
let testDb: PgTestDb;
let token: string;

before(async () => {
  testDb = await setupPgTestDb('reporting-by-category');
  await import('../../src/models/index.js');
  app = (await import('../../src/app.js')).default;

  authed = request.agent(app);
  const reg = await authed.post('/api/auth/register').send({
    email: 'rep-bycat@example.com',
    displayName: 'ByCat',
    password: 'password123',
  });
  assert.equal(reg.status, 201);
  const mint = await authed.post('/api/v1/tokens').send({ label: 'BC' });
  assert.equal(mint.status, 201);
  token = mint.body.plaintext;

  const accRes = await authed.post('/api/accounts').send({
    name: 'Chequing', accountType: 'checking', defaultCurrency: 'CAD',
  });
  assert.equal(accRes.status, 201);
  const accountId: number = accRes.body.id;

  const { Transaction: TxnModel, Account: AccModel } = await import('../../src/models/index.js');
  const acc = await AccModel.findByPk(accountId);
  if (acc) {
    // Current period (March 2025): 3 groceries + 1 entertainment
    for (let i = 0; i < 3; i++) {
      await TxnModel.create({
        accountId, householdId: acc.householdId,
        date: `2025-03-${10 + i}`, amount: -(100 + i), currency: 'CAD',
        merchantRaw: `Grocery ${i}`, merchantClean: `Grocery ${i}`,
        importBatch: `bc-g-${i}`, sourceRowFingerprint: `rfp-bc-g-${i}`,
        sourceIdentityFingerprint: `ifp-bc-g-${i}`,
        finalCategory: 'groceries',
        finalSplitType: 'all_mine', finalBusiness: false, reviewFlag: false, txnType: 'purchase',
      });
    }
    await TxnModel.create({
      accountId, householdId: acc.householdId,
      date: '2025-03-15', amount: -50, currency: 'CAD',
      merchantRaw: 'Cinema', merchantClean: 'Cinema',
      importBatch: 'bc-ent-0', sourceRowFingerprint: 'rfp-bc-ent-0',
      sourceIdentityFingerprint: 'ifp-bc-ent-0',
      finalCategory: 'entertainment',
      finalSplitType: 'all_mine', finalBusiness: false, reviewFlag: false, txnType: 'purchase',
    });

    // Previous period (February 2025): 1 groceries (less spend → trend negative for groceries in March vs Feb)
    await TxnModel.create({
      accountId, householdId: acc.householdId,
      date: '2025-02-10', amount: -50, currency: 'CAD',
      merchantRaw: 'Grocery Prev', merchantClean: 'Grocery Prev',
      importBatch: 'bc-g-prev', sourceRowFingerprint: 'rfp-bc-g-prev',
      sourceIdentityFingerprint: 'ifp-bc-g-prev',
      finalCategory: 'groceries',
      finalSplitType: 'all_mine', finalBusiness: false, reviewFlag: false, txnType: 'purchase',
    });
    // entertainment in February: none → trendVsPreviousPeriod for entertainment should be null
  }
});

after(async () => {
  await teardownPgTestDb(testDb);
});

test('GET /api/v1/spending/by-category returns categories array with correct fields', async () => {
  const res = await request(app)
    .get('/api/v1/spending/by-category?start=2025-03-01&end=2025-03-31')
    .set('Authorization', `Bearer ${token}`);
  assert.equal(res.status, 200);
  const body = res.body;
  assert.ok(typeof body.start === 'string');
  assert.ok(typeof body.end === 'string');
  assert.ok(Array.isArray(body.categories));
  for (const c of body.categories) {
    assert.ok('categoryId' in c);
    assert.ok('name' in c);
    assert.ok(typeof c.amount === 'number');
    assert.ok(typeof c.percentage === 'number');
    assert.ok(typeof c.transactionCount === 'number');
    assert.ok('trendVsPreviousPeriod' in c);
  }
});

test('transactionCount equals the number of transactions in the window', async () => {
  const res = await request(app)
    .get('/api/v1/spending/by-category?start=2025-03-01&end=2025-03-31')
    .set('Authorization', `Bearer ${token}`);
  assert.equal(res.status, 200);
  const groceries = res.body.categories.find((c: { categoryId: string }) => c.categoryId === 'groceries');
  assert.ok(groceries, 'groceries category must exist');
  assert.equal(groceries.transactionCount, 3);
});

test('trendVsPreviousPeriod is positive when current spend > previous', async () => {
  const res = await request(app)
    .get('/api/v1/spending/by-category?start=2025-03-01&end=2025-03-31')
    .set('Authorization', `Bearer ${token}`);
  assert.equal(res.status, 200);
  // groceries: current=300+1+2=303, prev=50 → trend positive
  const groceries = res.body.categories.find((c: { categoryId: string }) => c.categoryId === 'groceries');
  assert.ok(groceries.trendVsPreviousPeriod !== null);
  assert.ok(groceries.trendVsPreviousPeriod > 0, 'grocery spend up vs previous period');
});

test('trendVsPreviousPeriod is null when previous period has no spend', async () => {
  const res = await request(app)
    .get('/api/v1/spending/by-category?start=2025-03-01&end=2025-03-31')
    .set('Authorization', `Bearer ${token}`);
  assert.equal(res.status, 200);
  // entertainment: no transactions in Feb → trendVsPreviousPeriod is null
  const ent = res.body.categories.find((c: { categoryId: string }) => c.categoryId === 'entertainment');
  assert.ok(ent, 'entertainment category must exist');
  assert.equal(ent.trendVsPreviousPeriod, null);
});

test('percentages sum to approximately 1', async () => {
  const res = await request(app)
    .get('/api/v1/spending/by-category?start=2025-03-01&end=2025-03-31')
    .set('Authorization', `Bearer ${token}`);
  assert.equal(res.status, 200);
  const total = res.body.categories.reduce((s: number, c: { percentage: number }) => s + c.percentage, 0);
  assert.ok(Math.abs(total - 1) < 0.05, `percentages should sum to ~1, got ${total}`);
});
