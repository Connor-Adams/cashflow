/**
 * Task 15 finding 1: the Items page (items.ts) and the receipts drawer
 * (receipts.ts) both serialize `cardOwnership` for the same ExternalOrder,
 * derived independently in each file. Before this fix they could disagree on
 * the exact same order: items.ts clamped a residual raw 'foreign' (the
 * derivable-account guard case -- an Amazon order whose accepted link's
 * account has an opaque short code, so there is no basis to compare last4s)
 * down to 'known', while receipts.ts applied no such clamp at all and
 * serialized the raw 'foreign'. Neither was right: the honest state is
 * 'unknown' (counted on benefit of the doubt, badged "unverified card").
 *
 * This test builds ONE order reachable through both endpoints (an accepted
 * TransactionOrderLink for items.ts, a Receipt for receipts.ts, both
 * pointing at the same transaction/account) and asserts they now agree.
 */
import { before, after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { createFingerprinter, makeAmazonTransaction } from './cardOwnershipTestHelpers';

process.env.DATABASE_PATH = ':memory:';

let models: typeof import('../models');
let app: express.Express;
let household: { id: number };

before(async () => {
  models = await import('../models');
  await models.sequelize.sync({ force: true });
  const itemsRouter = (await import('./items')).default;
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
  app.use('/api', itemsRouter);
  app.use('/api', receiptsRouter);
});

after(async () => {
  await models.sequelize.close();
});

beforeEach(async () => {
  await models.Receipt.destroy({ where: {}, truncate: true });
  await models.ExternalOrderItem.destroy({ where: {}, truncate: true });
  await models.TransactionOrderLink.destroy({ where: {}, truncate: true });
  await models.ExternalOrder.destroy({ where: {}, truncate: true });
  await models.Transaction.destroy({ where: {}, truncate: true });
  await models.Account.destroy({ where: {}, truncate: true });
  await models.Household.destroy({ where: {}, truncate: true });
  household = await models.Household.create({ name: 'CardOwnership Consistency HH' });
});

const fp = createFingerprinter('co-consistency');

test('the same order reports the same cardOwnership through /api/items and /api/transactions/:id/receipts (derivable-account guard case)', async () => {
  // Wealthsimple-style opaque short code: resolveAccountLast4 returns null,
  // so there is no basis to compare the order's last4 against this account.
  const account = await models.Account.create({
    householdId: household.id,
    owner: 'me',
    visibility: 'shared',
    name: 'Wealthsimple Cash',
    accountType: 'chequing',
    shortCode: 'HQ6LMLTK8CAD',
  } as never);
  const txn = await makeAmazonTransaction(models, household.id, account.id, fp);
  const order = await models.ExternalOrder.create({
    householdId: household.id,
    vendor: 'amazon',
    dedupeKey: 'k-consistency-opaque-1',
    orderDate: '2026-06-01',
    total: '50.00',
    subtotal: '50.00',
    currency: 'CAD',
    paymentLast4: '9999', // matches no account -- would be 'foreign' if comparable
    source: 'test',
  } as never);
  await models.ExternalOrderItem.create({
    externalOrderId: order.id,
    title: 'SharedGuardWidget',
    quantity: 1,
    unitPrice: '50.00',
    totalPrice: '50.00',
  } as never);
  await models.TransactionOrderLink.create({
    transactionId: txn.id,
    externalOrderId: order.id,
    confidence: '90.00',
    matchReason: 'test',
    status: 'accepted',
    linkedAmount: '50.00',
  } as never);
  await models.Receipt.create({
    transactionId: txn.id,
    externalOrderId: order.id,
    storedFilename: 'shared-guard.pdf.stored',
    originalName: 'shared-guard.pdf',
    mimeType: 'application/pdf',
    sizeBytes: 100,
  } as never);

  const itemsRes = await request(app).get('/api/items');
  assert.equal(itemsRes.status, 200);
  const itemRow = itemsRes.body.items.find(
    (r: { title: string }) => r.title === 'SharedGuardWidget',
  );
  assert.ok(itemRow, 'order must be visible on the Items page');

  const receiptsRes = await request(app).get(`/api/transactions/${txn.id}/receipts`);
  assert.equal(receiptsRes.status, 200);
  assert.equal(receiptsRes.body.length, 1);

  assert.equal(
    itemRow.order.cardOwnership,
    receiptsRes.body[0].order.cardOwnership,
    'the same order must report the same cardOwnership on both endpoints',
  );
  assert.equal(itemRow.order.cardOwnership, 'unknown');
});

test('KNOWN LIMITATION: a multi-link order can badge differently on the items and receipts endpoints', async () => {
  // This test documents an accepted limitation: when an Amazon order with a
  // mismatched last-4 is linked to multiple transactions spanning both
  // derivable and opaque accounts, the Items endpoint uses foreignOrderIds to
  // exclude the order only if ALL links have a derivable account (because an
  // opaque account has no basis for comparison). Then displayCardOwnership
  // clamps any residual 'foreign' to 'unknown'. But the receipts endpoint
  // checks the specific account behind each receipt independently, so the same
  // order can show 'foreign' for a receipt attached to a derivable account and
  // 'unknown' for a receipt attached to an opaque account. This is a cosmetic
  // difference (both count the item; only the badge label differs) and is
  // accepted because production has zero accepted Amazon links.
  //
  // See cardOwnership.ts and items.ts for the foreign-order exclusion logic
  // and why the derivable-account guard works differently in each endpoint.

  // Account A: RBC, derivable last4 '1234' (short code must be purely numeric)
  const accountA = await models.Account.create({
    householdId: household.id,
    owner: 'me',
    visibility: 'shared',
    name: 'RBC Visa',
    accountType: 'credit',
    shortCode: '5001234',
  } as never);

  // Account B: Wealthsimple, opaque short code
  const accountB = await models.Account.create({
    householdId: household.id,
    owner: 'me',
    visibility: 'shared',
    name: 'Wealthsimple Cash',
    accountType: 'chequing',
    shortCode: 'HQ6LMLTK8CAD',
  } as never);

  // Transaction A, linked to derivable account
  const txnA = await models.Transaction.create({
    accountId: accountA.id,
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

  // Transaction B, linked to opaque account
  const txnB = await models.Transaction.create({
    accountId: accountB.id,
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

  // Amazon order with last4 that matches neither account
  const order = await models.ExternalOrder.create({
    householdId: household.id,
    vendor: 'amazon',
    dedupeKey: 'k-consistency-multilink-1',
    orderDate: '2026-06-01',
    total: '50.00',
    subtotal: '50.00',
    currency: 'CAD',
    paymentLast4: '9999',
    source: 'test',
  } as never);

  // Order item
  await models.ExternalOrderItem.create({
    externalOrderId: order.id,
    title: 'MultiLinkWidget',
    quantity: 1,
    unitPrice: '50.00',
    totalPrice: '50.00',
  } as never);

  // Link to derivable account
  await models.TransactionOrderLink.create({
    transactionId: txnA.id,
    externalOrderId: order.id,
    confidence: '90.00',
    matchReason: 'test',
    status: 'accepted',
    linkedAmount: '50.00',
  } as never);

  // Link to opaque account (this saves the order from exclusion in items.ts)
  await models.TransactionOrderLink.create({
    transactionId: txnB.id,
    externalOrderId: order.id,
    confidence: '85.00',
    matchReason: 'test',
    status: 'accepted',
    linkedAmount: '50.00',
  } as never);

  // Receipt attached to derivable account's transaction
  await models.Receipt.create({
    transactionId: txnA.id,
    externalOrderId: order.id,
    storedFilename: 'multilink.pdf.stored',
    originalName: 'multilink.pdf',
    mimeType: 'application/pdf',
    sizeBytes: 100,
  } as never);

  // Items endpoint: order is saved from exclusion by the opaque link, then
  // clamped to 'unknown' (not 'foreign') in displayCardOwnership
  const itemsRes = await request(app).get('/api/items');
  assert.equal(itemsRes.status, 200);
  const itemRow = itemsRes.body.items.find(
    (r: { title: string }) => r.title === 'MultiLinkWidget',
  );
  assert.ok(itemRow, 'multi-link order must be visible on the Items page');
  assert.equal(itemRow.order.cardOwnership, 'unknown', 'items endpoint shows unknown');

  // Receipts endpoint for the derivable account: the order's last4 does not
  // match any account, and the linked account is derivable, so it shows
  // 'foreign'. This differs from the items endpoint because items.ts uses an
  // OR across all links (saved if ANY link has an opaque account), while
  // receipts.ts checks only the specific account behind this receipt.
  const receiptsResA = await request(app).get(`/api/transactions/${txnA.id}/receipts`);
  assert.equal(receiptsResA.status, 200);
  assert.equal(receiptsResA.body.length, 1);
  assert.equal(
    receiptsResA.body[0].order.cardOwnership,
    'foreign',
    'receipts endpoint shows foreign for derivable account',
  );

  // The mismatch: same order, same receipt, but different cardOwnership
  // badges on the two endpoints. items endpoint shows 'unknown', receipts
  // endpoint shows 'foreign'.
  assert.notEqual(
    itemRow.order.cardOwnership,
    receiptsResA.body[0].order.cardOwnership,
    'multi-link order can differ between items and receipts endpoints',
  );
});
