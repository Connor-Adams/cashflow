import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { rowFingerprint, stableIdentityFingerprint } from '../../src/import/fingerprint';
import { setupPgTestDb, teardownPgTestDb, type PgTestDb } from './_setup/pgTestDb.js';

let app: import('express').Express;
let authed: ReturnType<typeof request.agent>;
let models: typeof import('../../src/models/index.js');
let testDb: PgTestDb;

before(async () => {
  testDb = await setupPgTestDb('amazon');
  models = await import('../../src/models/index.js');
  app = (await import('../../src/app.js')).default;
  authed = request.agent(app);
  const register = await authed.post('/api/auth/register').send({
    email: 'amazon@example.com',
    displayName: 'Amazon User',
    password: 'password123',
  });
  assert.equal(register.status, 201);
  const account = await authed.post('/api/accounts').send({
    name: 'Amazon Card',
    owner: 'me',
    defaultCurrency: 'CAD',
  });
  assert.equal(account.status, 201);
});

after(async () => {
  await teardownPgTestDb(testDb);
});

async function createTxn(merchant: string, amount: number, date = '2026-05-05') {
  const acc = await models.Account.findOne();
  assert.ok(acc);
  return models.Transaction.create({
    accountId: acc.id,
    householdId: acc.householdId,
    createdByUserId: acc.ownerUserId,
    visibility: 'shared',
    ownershipType: 'me',
    importBatch: 'amazon-test',
    date,
    merchantRaw: merchant,
    merchantClean: merchant,
    amount: String(amount),
    currency: 'CAD',
    notes: null,
    sourceReference: null,
    sourceRowFingerprint: rowFingerprint({
      accountId: acc.id,
      date,
      amount,
      currency: 'CAD',
      merchantRaw: merchant,
      sourceReference: '',
    }),
    sourceIdentityFingerprint: stableIdentityFingerprint({
      accountId: acc.id,
      date,
      amount,
      currency: 'CAD',
      merchantRaw: merchant,
    }),
  } as never);
}

test('duplicate upload does not duplicate orders', async () => {
  const csv = [
    'Order ID,Order Date,Shipment Date,Title,Quantity,Item Total,Order Total',
    '701-2222222-2222222,2026-05-01,2026-05-02,USB-C Cable,1,42.00,42.00',
  ].join('\n');
  const first = await authed
    .post('/api/amazon/import')
    .attach('file', Buffer.from(csv), { filename: 'amazon.csv', contentType: 'text/csv' });
  assert.equal(first.status, 200);
  assert.equal(first.body.created, 1);

  const second = await authed
    .post('/api/amazon/import')
    .attach('file', Buffer.from(csv), { filename: 'amazon.csv', contentType: 'text/csv' });
  assert.equal(second.status, 200);
  assert.equal(second.body.created, 0);
  assert.equal(second.body.skipped, 1);

  assert.equal(await models.ExternalOrder.count(), 1);
  assert.equal(await models.ExternalOrderItem.count(), 1);
});

test('many-to-many links are possible and accept/reject/unlink works', async () => {
  const txnA = await createTxn('AMAZON.CA', -42, '2026-05-05');
  const txnB = await createTxn('AMZN MKTP CA', -20, '2026-05-06');
  const orders = await models.ExternalOrder.findAll();
  assert.ok(orders[0]);

  const manualA = await authed
    .post('/api/amazon/links/manual')
    .send({ transactionId: txnA.id, externalOrderId: orders[0].id });
  assert.equal(manualA.status, 201);
  const manualB = await authed
    .post('/api/amazon/links/manual')
    .send({ transactionId: txnB.id, externalOrderId: orders[0].id });
  assert.equal(manualB.status, 201);

  assert.equal(await models.TransactionOrderLink.count(), 2);

  const reject = await authed.post(`/api/amazon/links/${manualA.body.id}/reject`);
  assert.equal(reject.status, 200);
  assert.equal(reject.body.status, 'rejected');
  const accept = await authed.post(`/api/amazon/links/${manualA.body.id}/accept`);
  assert.equal(accept.status, 200);
  assert.equal(accept.body.status, 'accepted');
  const unlink = await authed.delete(`/api/amazon/links/${manualB.body.id}`);
  assert.equal(unlink.status, 204);
  assert.equal(await models.TransactionOrderLink.count(), 1);
});

test('matching suggests amount and nearby date candidates', async () => {
  await createTxn('Amazon Marketplace', -42, '2026-05-05');
  await createTxn('Local Cafe', -9, '2026-05-05');
  const run = await authed.post('/api/amazon/match/run');
  assert.equal(run.status, 200);
  assert.ok(run.body.suggested >= 1);

  const review = await authed.get('/api/amazon/review-transactions');
  assert.equal(review.status, 200);
  assert.ok(review.body.some((txn: { merchantClean: string }) => txn.merchantClean === 'Amazon Marketplace'));
  assert.ok(!review.body.some((txn: { merchantClean: string }) => txn.merchantClean === 'Local Cafe'));
});
