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

before(async () => {
  testDb = await setupPgTestDb('external-orders-list');
  models = await import('../../src/models/index.js');
  app = (await import('../../src/app.js')).default;
  authed = request.agent(app);
  const register = await authed.post('/api/auth/register').send({
    email: 'orders@example.com',
    displayName: 'Orders User',
    password: 'password123',
  });
  assert.equal(register.status, 201);
  // Fresh test DB → exactly one household/account. Read them from the DB rather
  // than depending on response body shapes.
  const hh = await models.Household.findOne();
  assert.ok(hh, 'household exists after register');
  householdId = hh.id;
  await authed.post('/api/accounts').send({ name: 'Card', owner: 'me', defaultCurrency: 'CAD' });
  const account = await models.Account.findOne();
  assert.ok(account, 'account exists after create');
  accountId = account.id;

  // A Gmail-sourced order, linked (accepted) to a transaction.
  const gmailOrder = await models.ExternalOrder.create({
    householdId,
    vendor: 'apple',
    dedupeKey: 'gmail-1',
    orderDate: '2026-05-20',
    total: '9.99',
    currency: 'CAD',
    source: 'email_gmail_apple',
  } as never);
  const txn = await models.Transaction.create({
    accountId,
    householdId,
    importBatch: 'orders-list-test',
    date: '2026-05-20',
    merchantRaw: 'APPLE.COM/BILL',
    merchantClean: 'Apple',
    amount: '-9.99',
    currency: 'CAD',
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
  await models.TransactionOrderLink.create({
    transactionId: txn.id,
    externalOrderId: gmailOrder.id,
    confidence: '95',
    matchReason: 'test',
    status: 'accepted',
  } as never);

  // An Amazon-sourced order, no links (orphan).
  await models.ExternalOrder.create({
    householdId,
    vendor: 'amazon',
    dedupeKey: 'amz-1',
    orderDate: '2026-05-22',
    total: '40.00',
    currency: 'CAD',
    source: 'amazon-csv',
  } as never);
});

after(async () => {
  await teardownPgTestDb(testDb);
});

test('GET /api/external-orders returns all household orders with derived linkStatus', async () => {
  const res = await authed.get('/api/external-orders');
  assert.equal(res.status, 200);
  assert.equal(res.body.length, 2);
  const apple = res.body.find((o: { vendor: string }) => o.vendor === 'apple');
  const amazon = res.body.find((o: { vendor: string }) => o.vendor === 'amazon');
  assert.equal(apple.linkStatus, 'linked');
  assert.equal(amazon.linkStatus, 'orphan');
  assert.ok(Array.isArray(apple.items));
});

test('group=gmail filters to email_gmail* sources', async () => {
  const res = await authed.get('/api/external-orders?group=gmail');
  assert.equal(res.status, 200);
  assert.equal(res.body.length, 1);
  assert.equal(res.body[0].vendor, 'apple');
});

test('group=amazon filters to vendor=amazon', async () => {
  const res = await authed.get('/api/external-orders?group=amazon');
  assert.equal(res.status, 200);
  assert.equal(res.body.length, 1);
  assert.equal(res.body[0].vendor, 'amazon');
});

test('rejects unauthenticated requests', async () => {
  const res = await request(app).get('/api/external-orders');
  assert.equal(res.status, 401);
});
