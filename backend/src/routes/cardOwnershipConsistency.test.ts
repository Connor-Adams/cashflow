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

let fpCounter = 0;
function fp(): string {
  fpCounter += 1;
  return `fp-co-consistency-${fpCounter}-${crypto.randomBytes(4).toString('hex')}`;
}

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
  const txn = await models.Transaction.create({
    accountId: account.id,
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
