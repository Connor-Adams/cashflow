import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { setupPgTestDb, teardownPgTestDb, type PgTestDb } from './_setup/pgTestDb.js';

let app: import('express').Express;
let authed: ReturnType<typeof request.agent>;
let testDb: PgTestDb;
let token: string;

const VALID_TYPES = new Set(['income', 'expense', 'transfer']);
const VALID_CADENCES = new Set(['weekly', 'biweekly', 'monthly', 'quarterly', 'annual']);

before(async () => {
  testDb = await setupPgTestDb('reporting-recurring');
  await import('../../src/models/index.js');
  app = (await import('../../src/app.js')).default;

  authed = request.agent(app);
  const reg = await authed.post('/api/auth/register').send({
    email: 'rep-recurring@example.com',
    displayName: 'Recurring',
    password: 'password123',
  });
  assert.equal(reg.status, 201);
  const mint = await authed.post('/api/v1/tokens').send({ label: 'RC' });
  assert.equal(mint.status, 201);
  token = mint.body.plaintext;

  const accRes = await authed.post('/api/accounts').send({
    name: 'Chequing', accountType: 'checking', defaultCurrency: 'CAD',
  });
  assert.equal(accRes.status, 201);
  const accountId: number = accRes.body.id;

  const { Subscription: SubModel, PlannedEvent: PeModel, Transaction: TxnModel, Account: AccModel } = await import('../../src/models/index.js');
  const acc = await AccModel.findByPk(accountId);
  if (!acc) return;

  // Source 1: Subscription
  await SubModel.create({
    householdId: acc.householdId,
    merchantName: 'Netflix',
    normalizedName: 'netflix',
    amount: '15.99',
    currency: 'CAD',
    cadence: 'monthly',
    lastChargeDate: '2025-05-01',
    nextExpectedDate: '2025-06-01',
    status: 'active',
    annualizedCost: '191.88',
    priceChangeDetected: false,
  });

  // Source 2: PlannedEvent with recurrenceRule
  await PeModel.create({
    userId: (await authed.get('/api/household').then(() => 1)),
    householdId: acc.householdId,
    type: 'income',
    name: 'Payroll',
    amount: '3000',
    currency: 'CAD',
    expectedDate: '2025-06-15',
    recurrenceRule: 'FREQ=MONTHLY;INTERVAL=1',
    source: 'manual',
    status: 'planned',
  });

  // Source 3: Seed enough transactions for detectRecurring to pick up a pattern
  for (let i = 0; i < 4; i++) {
    const month = String(i + 2).padStart(2, '0');
    await TxnModel.create({
      accountId, householdId: acc.householdId,
      date: `2025-${month}-05`, amount: -25.00, currency: 'CAD',
      merchantRaw: 'Spotify', merchantClean: 'Spotify',
      importBatch: `rc-sp-${i}`, sourceRowFingerprint: `rfp-rc-sp-${i}`,
      sourceIdentityFingerprint: `ifp-rc-sp-${i}`,
      finalCategory: 'entertainment',
      finalSplitType: 'all_mine', finalBusiness: false, reviewFlag: false, txnType: 'purchase',
    });
  }
});

after(async () => {
  await teardownPgTestDb(testDb);
});

test('GET /api/v1/recurring returns recurringItems array', async () => {
  const res = await request(app).get('/api/v1/recurring').set('Authorization', `Bearer ${token}`);
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.recurringItems));
});

test('all items have valid type and cadence from documented enums', async () => {
  const res = await request(app).get('/api/v1/recurring').set('Authorization', `Bearer ${token}`);
  assert.equal(res.status, 200);
  for (const item of res.body.recurringItems) {
    assert.ok(VALID_TYPES.has(item.type), `type "${item.type}" not in enum`);
    assert.ok(VALID_CADENCES.has(item.cadence), `cadence "${item.cadence}" not in enum`);
    assert.ok(typeof item.confidence === 'number');
    assert.ok(item.confidence >= 0 && item.confidence <= 1, `confidence ${item.confidence} out of range`);
  }
});

test('explicit Subscription source appears with confidence 1.0', async () => {
  const res = await request(app).get('/api/v1/recurring').set('Authorization', `Bearer ${token}`);
  assert.equal(res.status, 200);
  const netflix = res.body.recurringItems.find((i: { name: string }) => i.name === 'Netflix');
  assert.ok(netflix, 'Netflix subscription must appear');
  assert.equal(netflix.confidence, 1.0);
  assert.equal(netflix.cadence, 'monthly');
});

test('explicit PlannedEvent source appears with confidence 1.0', async () => {
  const res = await request(app).get('/api/v1/recurring').set('Authorization', `Bearer ${token}`);
  assert.equal(res.status, 200);
  const payroll = res.body.recurringItems.find((i: { name: string }) => i.name === 'Payroll');
  assert.ok(payroll, 'Payroll planned event must appear');
  assert.equal(payroll.confidence, 1.0);
  assert.equal(payroll.type, 'income');
});

test('detected items have confidence in (0, 1)', async () => {
  const res = await request(app).get('/api/v1/recurring').set('Authorization', `Bearer ${token}`);
  assert.equal(res.status, 200);
  const detected = res.body.recurringItems.filter((i: { id: string }) => i.id.startsWith('det_'));
  if (detected.length > 0) {
    for (const item of detected) {
      assert.ok(item.confidence >= 0 && item.confidence < 1, `detected confidence ${item.confidence} should be < 1`);
    }
  }
  // Both explicit sources are still present
  assert.ok(res.body.recurringItems.length >= 2);
});
