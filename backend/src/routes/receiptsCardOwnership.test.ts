/**
 * Task 15: GET /api/transactions/:transactionId/receipts builds the
 * ExternalOrderView-shaped `order` object consumed by ReceiptWithItems
 * (shared/api-types.ts). It must carry `cardOwnership`, derived per request
 * from accounts.short_code exactly like backend/src/routes/items.ts (see
 * items.test.ts and backend/src/amazon/cardOwnership.ts) -- and, unlike
 * items.ts, this endpoint does NOT exclude foreign-card orders, so a
 * genuinely foreign Amazon order's receipt must still surface
 * cardOwnership: 'foreign' rather than being silently hidden.
 *
 * Mounts the receipts router behind a stubbed req.auth (matching the
 * pattern in ./items.test.ts) on the per-process SQLite test DB.
 */
import { before, after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import express from 'express';
import request from 'supertest';

process.env.DATABASE_PATH = ':memory:';

let models: typeof import('../models');
let app: express.Express;
let household: { id: number };

before(async () => {
  models = await import('../models');
  await models.sequelize.sync({ force: true });
  const receiptsRouter = (await import('./receipts')).default;
  app = express();
  app.use((req, _res, next) => {
    req.auth = {
      user: { id: 1, globalRole: 'member' },
      household,
      role: 'owner',
    } as unknown as NonNullable<typeof req.auth>;
    next();
  });
  app.use('/api', receiptsRouter);
});

after(async () => {
  await models.sequelize.close();
});

beforeEach(async () => {
  await models.Receipt.destroy({ where: {}, truncate: true });
  await models.ExternalOrderItem.destroy({ where: {}, truncate: true });
  await models.ExternalOrder.destroy({ where: {}, truncate: true });
  await models.Transaction.destroy({ where: {}, truncate: true });
  await models.Account.destroy({ where: {}, truncate: true });
  await models.Household.destroy({ where: {}, truncate: true });
  household = await models.Household.create({ name: 'Receipts CardOwnership HH' });
});

let fpCounter = 0;
function fp(): string {
  fpCounter += 1;
  return `fp-receipts-co-${fpCounter}-${crypto.randomBytes(4).toString('hex')}`;
}

async function makeAccount(shortCode: string | null) {
  return models.Account.create({
    householdId: household.id,
    owner: 'me',
    visibility: 'shared',
    name: `Account ${shortCode ?? 'none'}`,
    accountType: 'credit_card',
    shortCode,
  } as never);
}

async function makeTransaction(accountId: number) {
  return models.Transaction.create({
    accountId,
    householdId: household.id,
    importBatch: 'test',
    date: '2026-06-01',
    merchantRaw: 'AMZN MKTP CA',
    merchantClean: 'Amazon',
    amount: '-50.00',
    currency: 'CAD',
    sourceRowFingerprint: fp(),
    sourceIdentityFingerprint: fp(),
    visibility: 'shared',
    ownershipType: 'shared',
    finalCategory: null,
    finalBusiness: false,
    finalSplitType: 'none',
    businessAmount: '0',
  } as never);
}

async function makeOrder(vendor: string, paymentLast4: string | null, dedupeKey: string) {
  return models.ExternalOrder.create({
    householdId: household.id,
    vendor,
    dedupeKey,
    orderDate: '2026-06-01',
    total: '50.00',
    subtotal: '50.00',
    currency: 'CAD',
    paymentLast4,
    source: 'test',
  } as never);
}

async function makeReceipt(transactionId: number, externalOrderId: number, originalName: string) {
  return models.Receipt.create({
    transactionId,
    externalOrderId,
    storedFilename: `${originalName}.stored`,
    originalName,
    mimeType: 'application/pdf',
    sizeBytes: 100,
  } as never);
}

test('a known-card order surfaces cardOwnership "known" on the receipt payload', async () => {
  const account = await makeAccount('701001'); // resolveAccountLast4 -> '1001'
  const txn = await makeTransaction(account.id);
  const order = await makeOrder('amazon', '1001', 'k-receipts-known-1');
  await makeReceipt(txn.id, order.id, 'known.pdf');

  const res = await request(app).get(`/api/transactions/${txn.id}/receipts`);
  assert.equal(res.status, 200);
  assert.equal(res.body[0].order.cardOwnership, 'known');
});

test('a no-last4 order surfaces cardOwnership "unknown"', async () => {
  const account = await makeAccount('701001');
  const txn = await makeTransaction(account.id);
  const order = await makeOrder('amazon', null, 'k-receipts-unknown-1');
  await makeReceipt(txn.id, order.id, 'unknown.pdf');

  const res = await request(app).get(`/api/transactions/${txn.id}/receipts`);
  assert.equal(res.status, 200);
  assert.equal(res.body[0].order.cardOwnership, 'unknown');
});

test('a genuinely foreign Amazon order surfaces cardOwnership "foreign" (not hidden here)', async () => {
  const account = await makeAccount('701001'); // -> '1001', order's last4 matches nothing
  const txn = await makeTransaction(account.id);
  const order = await makeOrder('amazon', '2662', 'k-receipts-foreign-1');
  await makeReceipt(txn.id, order.id, 'foreign.pdf');

  const res = await request(app).get(`/api/transactions/${txn.id}/receipts`);
  assert.equal(res.status, 200);
  assert.equal(res.body[0].order.cardOwnership, 'foreign');
});

test('a non-Amazon order with an unmatched last4 is never "foreign" (Costco regression)', async () => {
  await makeAccount('costco'); // opaque short code -- derives no last4
  const account = await makeAccount('701001');
  const txn = await makeTransaction(account.id);
  const order = await makeOrder('costco', '3114', 'k-receipts-costco-1'); // matches no account
  await makeReceipt(txn.id, order.id, 'costco.pdf');

  const res = await request(app).get(`/api/transactions/${txn.id}/receipts`);
  assert.equal(res.status, 200);
  assert.equal(res.body[0].order.cardOwnership, 'known');
});

// Task 15 findings 1 & 2: the derivable-account guard must also apply here,
// not just on the Items page (backend/src/routes/items.ts). An Amazon order
// reached via a receipt whose transaction sits on an opaque-short-code
// account (e.g. Wealthsimple's 'HQ6LMLTK8CAD') has no basis for comparison --
// the order's own last4 matching no account is not evidence of a foreign
// card when the account side cannot be compared at all. Before this fix,
// receipts.ts had no such guard and serialized a raw 'foreign', disagreeing
// with the Items page (which clamps the very same order). The honest result
// is 'unknown' (counted on benefit of the doubt), not 'known' (which would
// overclaim verification) and not 'foreign' (which would badge "not your
// card" on an order nothing excludes).
test('an Amazon order whose transaction sits on an account with no derivable last4 surfaces "unknown", not "foreign"', async () => {
  const account = await makeAccount('HQ6LMLTK8CAD'); // opaque -- derives no last4
  const txn = await makeTransaction(account.id);
  const order = await makeOrder('amazon', '9999', 'k-receipts-opaque-1'); // matches no account
  await makeReceipt(txn.id, order.id, 'opaque.pdf');

  const res = await request(app).get(`/api/transactions/${txn.id}/receipts`);
  assert.equal(res.status, 200);
  assert.equal(res.body[0].order.cardOwnership, 'unknown');
});
