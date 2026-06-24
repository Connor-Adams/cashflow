import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { testAgent, testRequest } from './_setup/testServer.js';
import { setupPgTestDb, teardownPgTestDb, type PgTestDb } from './_setup/pgTestDb.js';

let app: import('express').Express;
let authed: ReturnType<typeof request.agent>;
let models: typeof import('../../src/models/index.js');
let token: string;
let testDb: PgTestDb;
let householdId: number;
let accountId: number;
let userId: number;

before(async () => {
  testDb = await setupPgTestDb('amazon-capture-automatch');
  models = await import('../../src/models/index.js');
  app = (await import('../../src/app.js')).default;
  authed = testAgent(app);
  const register = await authed.post('/api/auth/register').send({
    email: 'automatch@example.com',
    displayName: 'Auto Match',
    password: 'password123',
  });
  assert.equal(register.status, 201);
  const mint = await authed.post('/api/capture/tokens').send({ label: 'Ext' });
  token = mint.body.plaintext;
  await authed.post('/api/accounts').send({ name: 'Card', owner: 'me', defaultCurrency: 'CAD' });
  const account = await models.Account.findOne();
  assert.ok(account);
  accountId = account.id;
  householdId = account.householdId as number;
  const user = await models.User.findOne();
  assert.ok(user);
  userId = user.id;
});

after(async () => {
  await teardownPgTestDb(testDb);
});

test('sync-status is empty before any capture', async () => {
  const res = await authed.get('/api/amazon/sync-status');
  assert.equal(res.status, 200);
  assert.equal(res.body.orderCount, 0);
  assert.equal(res.body.lastCapturedAt, null);
});

test('capturing an Amazon order auto-accepts a link to a sole high-confidence matching transaction', async () => {
  // Seed a transaction that should match the captured order (exact amount,
  // 1-day gap, Amazon merchant → score 90). As the SOLE candidate ≥85 it is
  // unambiguous, so runAmazonMatching auto-accepts it rather than leaving it
  // 'suggested' (decideAutoAccept: ≥85 + clear margin / sole qualifier).
  await models.Transaction.create({
    accountId,
    householdId,
    createdByUserId: userId,
    importBatch: 'test',
    date: '2026-05-06',
    merchantRaw: 'AMZN Mktp CA',
    merchantClean: 'AMZN Mktp CA',
    amount: '-19.99',
    currency: 'CAD',
    sourceRowFingerprint: 'fp-automatch-1',
    sourceIdentityFingerprint: 'fp-automatch-1',
  } as never);

  const res = await testRequest(app)
    .post('/api/capture/orders')
    .set('Authorization', `Bearer ${token}`)
    .send({
      vendor: 'amazon',
      client: 'extension',
      orders: [
        {
          vendorOrderId: '701-9999999-9999999',
          orderDate: '2026-05-05',
          total: 19.99,
          currency: 'CAD',
          paymentLast4: null,
          items: [{ title: 'A book', totalPrice: 19.99 }],
          rawSource: 'extension-amazon-v1',
        },
      ],
    });

  assert.equal(res.status, 200);
  assert.equal(res.body.created, 1);
  assert.ok(res.body.matchSuggested >= 1, `expected matchSuggested >= 1, got ${res.body.matchSuggested}`);

  const order = await models.ExternalOrder.findOne({ where: { vendorOrderId: '701-9999999-9999999' } });
  assert.equal(order!.source, 'extension-amazon-v1');
  const links = await models.TransactionOrderLink.findAll({ where: { externalOrderId: order!.id } });
  assert.equal(links.length, 1);
  assert.equal(links[0].status, 'accepted');
});

test('sync-status reports the capture afterward', async () => {
  const res = await authed.get('/api/amazon/sync-status');
  assert.equal(res.status, 200);
  assert.ok(res.body.orderCount >= 1);
  assert.ok(typeof res.body.lastCapturedAt === 'string' && res.body.lastCapturedAt.length > 0);
});
