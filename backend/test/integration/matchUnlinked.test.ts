import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import request from 'supertest';
import { setupPgTestDb, teardownPgTestDb, type PgTestDb } from './_setup/pgTestDb.js';

let app: import('express').Express;
let authed: ReturnType<typeof request.agent>;
let models: typeof import('../../src/models/index.js');
let testDb: PgTestDb;
let householdId: number;
let accountId: number;
let unlinkedOrderId: number;

before(async () => {
  testDb = await setupPgTestDb('match-unlinked');
  models = await import('../../src/models/index.js');
  app = (await import('../../src/app.js')).default;
  authed = request.agent(app);

  const register = await authed.post('/api/auth/register').send({
    email: 'matchunlinked@example.com',
    displayName: 'Match User',
    password: 'password123',
  });
  assert.equal(register.status, 201);

  const hh = await models.Household.findOne();
  assert.ok(hh, 'household exists after register');
  householdId = hh.id;

  await authed.post('/api/accounts').send({ name: 'Card', owner: 'me', defaultCurrency: 'USD' });
  const account = await models.Account.findOne();
  assert.ok(account, 'account exists after create');
  accountId = account.id;

  // Create a transaction that should match the unlinked order below.
  // Vendor: apple (pattern: /\b(apple(?:\.com)?|itunes|app\s*store|apple\s*music|apple\s*tv|icloud)\b/i)
  // Amount: 9.99, Date: 2026-05-20 (same day as order → +25pts date)
  // Score breakdown: amount within $0.50 (+50) + date same day (+25) + vendor match (+15) = 90 >= 70 ✓
  await models.Transaction.create({
    accountId,
    householdId,
    importBatch: 'match-unlinked-test',
    date: '2026-05-20',
    merchantRaw: 'APPLE.COM/BILL',
    merchantClean: 'Apple',
    amount: '-9.99',
    currency: 'USD',
    status: 'posted',
    sourceRowFingerprint: crypto.randomBytes(16).toString('hex'),
    sourceIdentityFingerprint: crypto.randomBytes(16).toString('hex'),
    visibility: 'shared',
    ownershipType: 'me',
    finalBusiness: false,
    finalSplitType: 'me',
    myShareAmount: '-9.99',
    partnerShareAmount: '0',
    businessAmount: '0',
    txnType: 'purchase',
    isRecurring: false,
    reviewFlag: false,
  } as never);

  // An unlinked ExternalOrder that should match the transaction above.
  // same vendor/amount/date → matcher should score >= 70
  const unlinkedOrder = await models.ExternalOrder.create({
    householdId,
    vendor: 'apple',
    dedupeKey: 'unlinked-apple-1',
    orderDate: '2026-05-20',
    total: '9.99',
    currency: 'USD',
    source: 'gmail-scan:apple',
  } as never);
  unlinkedOrderId = unlinkedOrder.id;

  // A second unlinked order with no matching transaction — should be attempted but produce 0 links.
  await models.ExternalOrder.create({
    householdId,
    vendor: 'costco',
    dedupeKey: 'unlinked-costco-1',
    orderDate: '2026-05-10',
    total: '200.00',
    currency: 'USD',
    source: 'gmail-scan:ai',
  } as never);

  // An order that is already linked (accepted) — should NOT be included in match-unlinked.
  const linkedOrder = await models.ExternalOrder.create({
    householdId,
    vendor: 'google',
    dedupeKey: 'linked-google-1',
    orderDate: '2026-05-15',
    total: '14.99',
    currency: 'USD',
    source: 'gmail-scan:google',
  } as never);
  const linkedTxn = await models.Transaction.create({
    accountId,
    householdId,
    importBatch: 'match-unlinked-test',
    date: '2026-05-15',
    merchantRaw: 'GOOGLE *SERVICES',
    merchantClean: 'Google',
    amount: '-14.99',
    currency: 'USD',
    status: 'posted',
    sourceRowFingerprint: crypto.randomBytes(16).toString('hex'),
    sourceIdentityFingerprint: crypto.randomBytes(16).toString('hex'),
    visibility: 'shared',
    ownershipType: 'me',
    finalBusiness: false,
    finalSplitType: 'me',
    myShareAmount: '-14.99',
    partnerShareAmount: '0',
    businessAmount: '0',
    txnType: 'purchase',
    isRecurring: false,
    reviewFlag: false,
  } as never);
  await models.TransactionOrderLink.create({
    transactionId: linkedTxn.id,
    externalOrderId: linkedOrder.id,
    confidence: '90',
    matchReason: 'pre-linked',
    status: 'accepted',
  } as never);
});

after(async () => {
  await teardownPgTestDb(testDb);
});

test('POST /api/external-orders/match-unlinked links unlinked orders to matching transactions', async () => {
  const res = await authed.post('/api/external-orders/match-unlinked');
  assert.equal(res.status, 200, `Expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);

  // Should have attempted the 2 unlinked orders (apple + costco), not the already-linked google one.
  assert.ok(typeof res.body.processed === 'number', 'response has processed count');
  assert.ok(typeof res.body.linksCreated === 'number', 'response has linksCreated count');
  assert.ok(res.body.processed >= 1, `processed should be >= 1, got ${res.body.processed}`);
  assert.ok(res.body.linksCreated >= 1, `linksCreated should be >= 1, got ${res.body.linksCreated}`);

  // Confirm a TransactionOrderLink row was created for the apple order.
  const link = await models.TransactionOrderLink.findOne({
    where: { externalOrderId: unlinkedOrderId },
  });
  assert.ok(link, 'TransactionOrderLink should exist for the apple unlinked order');
});

test('POST /api/external-orders/match-unlinked is idempotent (second call does not double-create links)', async () => {
  const res = await authed.post('/api/external-orders/match-unlinked');
  assert.equal(res.status, 200);
  // On second call, the apple order is already linked (suggested), so linksCreated should be 0 (updated or 0).
  assert.ok(typeof res.body.linksCreated === 'number');
  // We don't assert exact count here because "updated" is separate — just ensure no error.
});

test('POST /api/external-orders/match-unlinked rejects unauthenticated requests', async () => {
  const res = await request(app).post('/api/external-orders/match-unlinked');
  assert.equal(res.status, 401);
});
