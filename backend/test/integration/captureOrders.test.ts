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

before(async () => {
  testDb = await setupPgTestDb('capture-orders');
  models = await import('../../src/models/index.js');
  app = (await import('../../src/app.js')).default;
  authed = testAgent(app);
  const register = await authed.post('/api/auth/register').send({
    email: 'capture@example.com',
    displayName: 'Capture User',
    password: 'password123',
  });
  assert.equal(register.status, 201);
  const mint = await authed.post('/api/capture/tokens').send({ label: 'Test' });
  assert.equal(mint.status, 201);
  token = mint.body.plaintext;

  await authed.post('/api/accounts').send({ name: 'Card', owner: 'me', defaultCurrency: 'CAD' });
});

after(async () => {
  await teardownPgTestDb(testDb);
});

test('rejects POST /capture/orders without bearer token', async () => {
  const res = await testRequest(app).post('/api/capture/orders').send({ vendor: 'amazon', orders: [] });
  assert.equal(res.status, 401);
});

test('rejects POST /capture/orders with wrong-format token', async () => {
  const res = await testRequest(app)
    .post('/api/capture/orders')
    .set('Authorization', 'Bearer not-a-cfc-token')
    .send({ vendor: 'amazon', orders: [] });
  assert.equal(res.status, 401);
});

test('accepts a valid POST and creates ExternalOrder + items', async () => {
  const res = await testRequest(app)
    .post('/api/capture/orders')
    .set('Authorization', `Bearer ${token}`)
    .send({
      vendor: 'amazon',
      orders: [
        {
          vendorOrderId: '112-2222222-2222222',
          orderDate: '2026-05-05',
          total: 19.99,
          currency: 'CAD',
          paymentLast4: '0042',
          items: [{ title: 'A book', totalPrice: 19.99 }],
          rawSource: 'bookmarklet-amazon-v1',
        },
      ],
    });
  assert.equal(res.status, 200);
  assert.equal(res.body.created, 1);
  const orders = await models.ExternalOrder.findAll();
  assert.equal(orders.length, 1);
  assert.equal(orders[0].vendor, 'amazon');
});

test('second POST with identical payload is a no-op', async () => {
  const body = {
    vendor: 'amazon',
    orders: [
      {
        vendorOrderId: '112-3333333-3333333',
        orderDate: '2026-05-06',
        total: 5,
        currency: 'CAD',
        paymentLast4: null,
        items: [{ title: 'Same' }],
        rawSource: 'bookmarklet-amazon-v1',
      },
    ],
  };
  const first = await testRequest(app).post('/api/capture/orders').set('Authorization', `Bearer ${token}`).send(body);
  assert.equal(first.body.created, 1);
  const second = await testRequest(app).post('/api/capture/orders').set('Authorization', `Bearer ${token}`).send(body);
  assert.equal(second.status, 200);
  assert.equal(second.body.created, 0);
  assert.equal(second.body.skipped, 1);
});

test('CORS preflight allows amazon.com origin', async () => {
  const res = await testRequest(app)
    .options('/api/capture/orders')
    .set('Origin', 'https://www.amazon.com')
    .set('Access-Control-Request-Method', 'POST')
    .set('Access-Control-Request-Headers', 'authorization,content-type');
  assert.ok(res.status === 204 || res.status === 200, `expected 200/204, got ${res.status}`);
  assert.equal(res.headers['access-control-allow-origin'], 'https://www.amazon.com');
});

test('rejects POST with invalid calendar date in YYYY-MM-DD format', async () => {
  const res = await testRequest(app)
    .post('/api/capture/orders')
    .set('Authorization', `Bearer ${token}`)
    .send({
      vendor: 'amazon',
      orders: [
        {
          vendorOrderId: 'INVALID-DATE',
          orderDate: '2026-13-45',  // YYYY-MM-DD shape but not a real date
          total: 10,
          currency: 'CAD',
          paymentLast4: null,
          items: [{ title: 'x' }],
          rawSource: 'bookmarklet-amazon-v1',
        },
      ],
    });
  assert.equal(res.status, 400);
  assert.match(String(res.body.error ?? ''), /orders\[0\]\.orderDate/);
});

test('rejects POST /capture/orders-from-paste without a session', async () => {
  const res = await testRequest(app)
    .post('/api/capture/orders-from-paste')
    .send({ vendor: 'amazon', orders: [] });
  assert.equal(res.status, 401);
});

test('accepts POST /capture/orders-from-paste with session auth and tags source as bookmarklet-paste', async () => {
  const res = await authed.post('/api/capture/orders-from-paste').send({
    vendor: 'apple',
    orders: [
      {
        vendorOrderId: 'PASTE-APPLE-1',
        orderDate: '2026-05-08',
        total: 4.99,
        currency: 'CAD',
        paymentLast4: null,
        items: [{ title: 'iCloud+ 50GB', totalPrice: 4.99 }],
        rawSource: 'bookmarklet-apple-v1',
      },
    ],
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.created, 1);
  const order = await models.ExternalOrder.findOne({
    where: { vendorOrderId: 'PASTE-APPLE-1' },
  });
  assert.ok(order);
  assert.equal(order.source, 'bookmarklet-paste-apple-v1');
});

test('rejects POST /capture/orders-from-paste with malformed payload', async () => {
  const res = await authed.post('/api/capture/orders-from-paste').send({
    vendor: 'apple',
    orders: [
      { vendorOrderId: 'x', orderDate: 'not-a-date', total: 1, currency: 'CAD', items: [] },
    ],
  });
  assert.equal(res.status, 400);
  assert.match(String(res.body.error ?? ''), /orderDate must be YYYY-MM-DD/);
});

test('post-capture backfill enriches a matching transaction', async () => {
  const acc = await models.Account.findOne();
  assert.ok(acc);
  const txn = await models.Transaction.create({
    accountId: acc.id,
    householdId: acc.householdId,
    createdByUserId: acc.ownerUserId,
    visibility: 'shared',
    ownershipType: 'me',
    importBatch: 'capture-test',
    date: '2026-05-07',
    merchantRaw: 'AMZN MKTP CA',
    merchantClean: 'AMZN MKTP CA',
    amount: '-42.50',
    currency: 'CAD',
    notes: null,
    sourceReference: null,
    sourceRowFingerprint: 'capture-test-fp-1',
    sourceIdentityFingerprint: 'capture-test-identity-1',
    txnType: 'purchase',
    reviewFlag: true,
    isRecurring: false,
  } as never);

  const res = await testRequest(app)
    .post('/api/capture/orders')
    .set('Authorization', `Bearer ${token}`)
    .send({
      vendor: 'amazon',
      orders: [
        {
          vendorOrderId: '112-4444444-4444444',
          orderDate: '2026-05-07',
          total: 42.50,
          currency: 'CAD',
          paymentLast4: null,
          items: [{ title: 'Linked item', totalPrice: 42.50 }],
          rawSource: 'bookmarklet-amazon-v1',
        },
      ],
    });
  assert.equal(res.status, 200);

  // Post-capture enrichment is enqueued via `scheduleInternalBackfill`, which
  // runs the actual backfill on the next tick (`setImmediate(drain)`). Wait
  // for the coordinator to drain instead of sleeping a fixed window — a 300ms
  // timeout was tight enough that slow CI workers occasionally raced the
  // `txn.reload()` and asserted on a not-yet-enriched row.
  //
  // Imported lazily so the module load (which transitively pulls
  // `src/models`) happens after `setupPgTestDb` has set DATABASE_URL.
  const { waitForBackfillDrain } = await import('../../src/import/backfillCoordinator.js');
  await waitForBackfillDrain(acc.householdId);

  await txn.reload();
  assert.equal(txn.merchantCanonical, 'Amazon');
});
