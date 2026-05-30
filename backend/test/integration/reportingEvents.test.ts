import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { setupPgTestDb, teardownPgTestDb, type PgTestDb } from './_setup/pgTestDb.js';

let app: import('express').Express;
let authed: ReturnType<typeof request.agent>;
let testDb: PgTestDb;
let token: string;
let tokenB: string;

const V1_TYPES = new Set(['large_purchase', 'income_received', 'subscription_started', 'subscription_cancelled']);

before(async () => {
  testDb = await setupPgTestDb('reporting-events');
  await import('../../src/models/index.js');
  app = (await import('../../src/app.js')).default;

  authed = request.agent(app);
  const reg = await authed.post('/api/auth/register').send({
    email: 'rep-events@example.com',
    displayName: 'Events',
    password: 'password123',
  });
  assert.equal(reg.status, 201);
  const mint = await authed.post('/api/v1/tokens').send({ label: 'EV' });
  assert.equal(mint.status, 201);
  token = mint.body.plaintext;

  const accRes = await authed.post('/api/accounts').send({
    name: 'Chequing', accountType: 'checking', defaultCurrency: 'CAD',
  });
  assert.equal(accRes.status, 201);
  const accountId: number = accRes.body.id;

  const {
    Transaction: TxnModel,
    Account: AccModel,
    Subscription: SubModel,
    PlannedEvent: PeModel,
    TransactionLargePurchaseReview: LprModel,
  } = await import('../../src/models/index.js');
  const acc = await AccModel.findByPk(accountId);
  if (!acc) return;

  // Seed a large purchase transaction with a review record
  const largeTxn = await TxnModel.create({
    accountId, householdId: acc.householdId,
    date: '2025-04-10', amount: -1200, currency: 'CAD',
    merchantRaw: 'Big TV', merchantClean: 'Big TV',
    importBatch: 'ev-lp-0', sourceRowFingerprint: 'rfp-ev-lp-0',
    sourceIdentityFingerprint: 'ifp-ev-lp-0',
    finalSplitType: 'all_mine', finalBusiness: false, reviewFlag: false, txnType: 'purchase',
  });
  await LprModel.create({ transactionId: largeTxn.id, status: 'pending' });

  // Seed a posted income planned event
  await PeModel.create({
    userId: 1,
    householdId: acc.householdId,
    type: 'income',
    name: 'Freelance Payment',
    amount: '800',
    currency: 'CAD',
    expectedDate: '2025-04-15',
    source: 'manual',
    status: 'posted',
  });

  // Seed a subscription that was started (created recently) and one that was cancelled
  await SubModel.create({
    householdId: acc.householdId,
    merchantName: 'Spotify',
    normalizedName: 'spotify',
    amount: '9.99',
    currency: 'CAD',
    cadence: 'monthly',
    lastChargeDate: '2025-04-05',
    status: 'active',
    annualizedCost: '119.88',
    priceChangeDetected: false,
  });

  await SubModel.create({
    householdId: acc.householdId,
    merchantName: 'Old Service',
    normalizedName: 'old_service',
    amount: '5.00',
    currency: 'CAD',
    cadence: 'monthly',
    lastChargeDate: '2025-01-01',
    status: 'cancelled',
    annualizedCost: '60.00',
    priceChangeDetected: false,
  });

  // Household B (isolation)
  const authedB = request.agent(app);
  const regB = await authedB.post('/api/auth/register').send({
    email: 'rep-events-b@example.com',
    displayName: 'Events B',
    password: 'password123',
  });
  assert.equal(regB.status, 201);
  const mintB = await authedB.post('/api/v1/tokens').send({ label: 'EVB' });
  assert.equal(mintB.status, 201);
  tokenB = mintB.body.plaintext;
});

after(async () => {
  await teardownPgTestDb(testDb);
});

test('GET /api/v1/events returns events array', async () => {
  const res = await request(app)
    .get('/api/v1/events?start=2025-01-01&end=2025-12-31')
    .set('Authorization', `Bearer ${token}`);
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.events));
});

test('all returned events have a v1 type from the documented set', async () => {
  const res = await request(app)
    .get('/api/v1/events?start=2025-01-01&end=2025-12-31')
    .set('Authorization', `Bearer ${token}`);
  assert.equal(res.status, 200);
  for (const ev of res.body.events) {
    assert.ok(V1_TYPES.has(ev.type), `event type "${ev.type}" not in v1 set`);
    assert.ok(typeof ev.id === 'string');
    assert.ok(typeof ev.date === 'string');
    assert.ok(typeof ev.title === 'string');
  }
});

test('events are returned newest first', async () => {
  const res = await request(app)
    .get('/api/v1/events?start=2025-01-01&end=2025-12-31')
    .set('Authorization', `Bearer ${token}`);
  assert.equal(res.status, 200);
  const dates: string[] = res.body.events.map((e: { date: string }) => e.date);
  for (let i = 1; i < dates.length; i++) {
    assert.ok(dates[i - 1] >= dates[i], `event at index ${i - 1} (${dates[i - 1]}) should be >= ${dates[i]}`);
  }
});

test('limit is respected and clamped to 200', async () => {
  const res = await request(app)
    .get('/api/v1/events?limit=1&start=2025-01-01&end=2025-12-31')
    .set('Authorization', `Bearer ${token}`);
  assert.equal(res.status, 200);
  assert.ok(res.body.events.length <= 1);

  const res2 = await request(app)
    .get('/api/v1/events?limit=9999&start=2025-01-01&end=2025-12-31')
    .set('Authorization', `Bearer ${token}`);
  assert.equal(res2.status, 200);
  assert.ok(res2.body.events.length <= 200);
});

test('large_purchase event appears for seeded transaction with review', async () => {
  const res = await request(app)
    .get('/api/v1/events?start=2025-04-01&end=2025-04-30')
    .set('Authorization', `Bearer ${token}`);
  assert.equal(res.status, 200);
  const lp = res.body.events.find((e: { type: string }) => e.type === 'large_purchase');
  assert.ok(lp, 'large_purchase event must be present');
  assert.equal(lp.title, 'Big TV');
});

test('income_received event appears for posted planned event', async () => {
  const res = await request(app)
    .get('/api/v1/events?start=2025-04-01&end=2025-04-30')
    .set('Authorization', `Bearer ${token}`);
  assert.equal(res.status, 200);
  const income = res.body.events.find((e: { type: string }) => e.type === 'income_received');
  assert.ok(income, 'income_received event must be present');
  assert.equal(income.title, 'Freelance Payment');
});

test('subscription_cancelled event appears for cancelled subscription', async () => {
  const res = await request(app)
    .get('/api/v1/events?start=2024-01-01&end=2027-12-31')
    .set('Authorization', `Bearer ${token}`);
  assert.equal(res.status, 200);
  const cancelled = res.body.events.find((e: { type: string; title: string }) =>
    e.type === 'subscription_cancelled' && e.title === 'Old Service');
  assert.ok(cancelled, 'subscription_cancelled event must be present');
});

test('household isolation: household B does not see household A events', async () => {
  const resA = await request(app)
    .get('/api/v1/events?start=2025-01-01&end=2025-12-31')
    .set('Authorization', `Bearer ${token}`);
  const resB = await request(app)
    .get('/api/v1/events?start=2025-01-01&end=2025-12-31')
    .set('Authorization', `Bearer ${tokenB}`);
  assert.equal(resA.status, 200);
  assert.equal(resB.status, 200);
  const aIds = new Set(resA.body.events.map((e: { id: string }) => e.id));
  for (const ev of resB.body.events) {
    assert.ok(!aIds.has(ev.id), 'household B events must not appear in household A');
  }
});
