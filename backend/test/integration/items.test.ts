/**
 * Integration tests for `backend/src/routes/items.ts`.
 *
 * Setup mirrors `backend/test/integration/transactions.test.ts`:
 *   - isolated SQLite DB
 *   - bootstrap superadmin
 *   - two non-superadmin households (A and B) via `seedHousehold` helper
 *
 * Items are written via direct model creates for tight fixture control.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import request from 'supertest';
import { seedHousehold } from '../helpers/seedHousehold.js';
import { setupPgTestDb, teardownPgTestDb, type PgTestDb } from './_setup/pgTestDb.js';

let testDb: PgTestDb;
let app: import('express').Express;
let superAgent: ReturnType<typeof request.agent>;
let agentA: ReturnType<typeof request.agent>;
let agentB: ReturnType<typeof request.agent>;

before(async () => {
  testDb = await setupPgTestDb('items');

  const mod = await import('../../src/app.js');
  app = mod.default;

  superAgent = request.agent(app);
  const register = await superAgent.post('/api/auth/register').send({
    email: 'super-items@example.com',
    displayName: 'Super Items',
    password: 'password123',
  });
  assert.equal(register.status, 201);

  const a = await seedHousehold('ItemsA', 'A Partner');
  agentA = request.agent(app);
  agentA.jar.setCookie(`cashflow_session=${a.token}; Path=/`);

  const b = await seedHousehold('ItemsB', 'B Partner');
  agentB = request.agent(app);
  agentB.jar.setCookie(`cashflow_session=${b.token}; Path=/`);
});

after(async () => {
  await teardownPgTestDb(testDb);
});

test('GET /api/items returns empty list for new household', async () => {
  const res = await agentA.get('/api/items');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { items: [], nextCursor: null });
});

test('GET /api/items returns enriched rows from joined tables', async () => {
  const { Account, ExternalOrder, ExternalOrderItem, Receipt, Transaction } = await import(
    '../../src/models/index.js'
  );
  const householdAId = (await agentA.get('/api/auth/me')).body.user.household.id;
  const account = await Account.create({
    householdId: householdAId,
    owner: 'me',
    visibility: 'shared',
    name: 'A Chequing',
    accountType: 'checking',
  } as never);
  const txn = await Transaction.create({
    accountId: account.id,
    householdId: householdAId,
    importBatch: 'b1',
    date: '2026-05-20',
    merchantRaw: 'Amazon',
    merchantClean: 'Amazon',
    amount: '-42.18',
    currency: 'USD',
    sourceRowFingerprint: crypto.randomBytes(16).toString('hex'),
    sourceIdentityFingerprint: crypto.randomBytes(16).toString('hex'),
    visibility: 'shared',
    ownershipType: 'shared',
    finalCategory: null,
    finalBusiness: false,
    finalSplitType: 'none',
    businessAmount: '0',
  } as never);
  const order = await ExternalOrder.create({
    householdId: householdAId,
    vendor: 'amazon',
    dedupeKey: 'amz-1',
    subtotal: '40.00',
    tax: '2.18',
    shipping: '0.00',
    total: '42.18',
    currency: 'USD',
    source: 'image',
  } as never);
  const receipt = await Receipt.create({
    transactionId: txn.id,
    storedFilename: 'r1.jpg',
    originalName: 'r1.jpg',
    mimeType: 'image/jpeg',
    sizeBytes: 1024,
    externalOrderId: order.id,
  } as never);
  const item = await ExternalOrderItem.create({
    externalOrderId: order.id,
    title: 'USB-C cable',
    quantity: 2,
    unitPrice: '9.50',
    totalPrice: '19.00',
    inferredCategory: 'Office',
    businessUsePercent: '100',
  } as never);

  const res = await agentA.get('/api/items');
  assert.equal(res.status, 200);
  assert.equal(res.body.items.length, 1);
  const row = res.body.items[0];
  assert.equal(row.id, item.id);
  assert.equal(row.title, 'USB-C cable');
  assert.equal(row.qty, 2);
  assert.equal(row.unitPrice, 9.5);
  assert.equal(row.totalPrice, 19);
  assert.equal(row.categoryEffective, 'Office');
  assert.equal(row.businessUseEffective, true);
  assert.equal(row.order.id, order.id);
  assert.equal(row.order.vendor, 'amazon');
  assert.equal(row.receipt.id, receipt.id);
  assert.equal(row.receipt.date, '2026-05-20');
  assert.equal(row.receipt.sourceTxnId, txn.id);
});

test('GET /api/items isolates households', async () => {
  const resA = await agentA.get('/api/items');
  const resB = await agentB.get('/api/items');
  assert.equal(resA.status, 200);
  assert.equal(resB.status, 200);
  assert.equal(resB.body.items.length, 0, 'household B should not see household A items');
  assert.ok(resA.body.items.length >= 1, 'household A should still see its items');
});

test('GET /api/items filters by category', async () => {
  const res = await agentA.get('/api/items?category=Office');
  assert.equal(res.status, 200);
  assert.ok(res.body.items.length >= 1);
  assert.ok(res.body.items.every((r: { categoryEffective: string | null }) => r.categoryEffective === 'Office'));
});

test('GET /api/items filters by businessUse=true', async () => {
  const res = await agentA.get('/api/items?businessUse=true');
  assert.equal(res.status, 200);
  assert.ok(res.body.items.every((r: { businessUseEffective: boolean }) => r.businessUseEffective));
});

test('GET /api/items filters by vendor substring', async () => {
  const res = await agentA.get('/api/items?vendor=ama');
  assert.equal(res.status, 200);
  assert.ok(res.body.items.every((r: { order: { vendor: string } }) => r.order.vendor.toLowerCase().includes('ama')));
});

test('GET /api/items filters by date range', async () => {
  const res = await agentA.get('/api/items?from=2026-05-19&to=2026-05-21');
  assert.equal(res.status, 200);
  for (const r of res.body.items) {
    assert.ok(r.receipt.date >= '2026-05-19' && r.receipt.date <= '2026-05-21');
  }
});

test('GET /api/items filters by price range', async () => {
  const res = await agentA.get('/api/items?minPrice=10&maxPrice=30');
  assert.equal(res.status, 200);
  for (const r of res.body.items) {
    if (r.totalPrice != null) {
      assert.ok(r.totalPrice >= 10 && r.totalPrice <= 30);
    }
  }
});

test('GET /api/items filters by q (case-insensitive title substring)', async () => {
  const res = await agentA.get('/api/items?q=USB');
  assert.equal(res.status, 200);
  assert.ok(res.body.items.every((r: { title: string }) => r.title.toLowerCase().includes('usb')));
});

test('GET /api/items shows items linked to a transaction via order link (no receipt)', async () => {
  const { Account, ExternalOrder, ExternalOrderItem, Transaction, TransactionOrderLink } =
    await import('../../src/models/index.js');
  const householdAId = (await agentA.get('/api/auth/me')).body.user.household.id;
  const account = await Account.create({
    householdId: householdAId,
    owner: 'me',
    visibility: 'shared',
    name: 'A Link Account',
    accountType: 'checking',
  } as never);
  const txn = await Transaction.create({
    accountId: account.id,
    householdId: householdAId,
    importBatch: 'b-link',
    date: '2026-04-01',
    merchantRaw: 'Costco',
    merchantClean: 'Costco',
    amount: '-50',
    currency: 'USD',
    sourceRowFingerprint: crypto.randomBytes(16).toString('hex'),
    sourceIdentityFingerprint: crypto.randomBytes(16).toString('hex'),
    visibility: 'shared',
    ownershipType: 'shared',
    finalCategory: null,
    finalBusiness: false,
    finalSplitType: 'none',
    businessAmount: '0',
  } as never);
  const order = await ExternalOrder.create({
    householdId: householdAId,
    vendor: 'linkonly',
    dedupeKey: 'linkonly-1',
    total: '50',
    currency: 'USD',
    source: 'amazon_report',
  } as never);
  const item = await ExternalOrderItem.create({
    externalOrderId: order.id,
    title: 'Paper towels',
    quantity: 1,
    totalPrice: '50',
    inferredCategory: 'Household',
  } as never);
  await TransactionOrderLink.create({
    transactionId: txn.id,
    externalOrderId: order.id,
    confidence: '90.00',
    matchReason: 'test',
    status: 'accepted',
  } as never);

  const res = await agentA.get('/api/items?vendor=linkonly');
  assert.equal(res.status, 200);
  assert.equal(res.body.items.length, 1, 'item linked via order link should appear without a receipt');
  const row = res.body.items[0];
  assert.equal(row.id, item.id);
  assert.equal(row.order.vendor, 'linkonly');
  assert.equal(row.receipt.sourceTxnId, txn.id);
  assert.equal(row.receipt.date, '2026-04-01');
});

test('GET /api/items shows an order item with a rejected-only link as unmatched', async () => {
  const { Account, ExternalOrder, ExternalOrderItem, Transaction, TransactionOrderLink } =
    await import('../../src/models/index.js');
  const householdAId = (await agentA.get('/api/auth/me')).body.user.household.id;
  const account = await Account.create({
    householdId: householdAId,
    owner: 'me',
    visibility: 'shared',
    name: 'A Rejected Account',
    accountType: 'checking',
  } as never);
  const txn = await Transaction.create({
    accountId: account.id,
    householdId: householdAId,
    importBatch: 'b-rej',
    date: '2026-04-02',
    merchantRaw: 'Costco',
    merchantClean: 'Costco',
    amount: '-9',
    currency: 'USD',
    sourceRowFingerprint: crypto.randomBytes(16).toString('hex'),
    sourceIdentityFingerprint: crypto.randomBytes(16).toString('hex'),
    visibility: 'shared',
    ownershipType: 'shared',
    finalCategory: null,
    finalBusiness: false,
    finalSplitType: 'none',
    businessAmount: '0',
  } as never);
  const order = await ExternalOrder.create({
    householdId: householdAId,
    vendor: 'rejectedonly',
    dedupeKey: 'rejectedonly-1',
    total: '9',
    currency: 'USD',
    source: 'amazon_report',
  } as never);
  await ExternalOrderItem.create({
    externalOrderId: order.id,
    title: 'wrong-match thing',
    quantity: 1,
    totalPrice: '9',
  } as never);
  await TransactionOrderLink.create({
    transactionId: txn.id,
    externalOrderId: order.id,
    confidence: '40.00',
    matchReason: 'test',
    status: 'rejected',
  } as never);

  const res = await agentA.get('/api/items?vendor=rejectedonly');
  assert.equal(res.status, 200);
  assert.equal(res.body.items.length, 1, 'imported item still surfaces as purchase history');
  assert.equal(
    res.body.items[0].receipt.sourceTxnId,
    null,
    'a rejected-only link leaves the item unmatched (no transaction)',
  );
});

test('GET /api/items shows an order item with no link or receipt as unmatched', async () => {
  const { ExternalOrder, ExternalOrderItem } = await import('../../src/models/index.js');
  const householdAId = (await agentA.get('/api/auth/me')).body.user.household.id;
  const order = await ExternalOrder.create({
    householdId: householdAId,
    vendor: 'orphanvendor',
    dedupeKey: 'orphan-1',
    total: '12',
    currency: 'USD',
    source: 'amazon_report',
  } as never);
  const item = await ExternalOrderItem.create({
    externalOrderId: order.id,
    title: 'orphan widget',
    quantity: 1,
    totalPrice: '12',
    inferredCategory: 'Gadgets',
  } as never);

  const res = await agentA.get('/api/items?vendor=orphanvendor');
  assert.equal(res.status, 200);
  assert.equal(res.body.items.length, 1, 'an unreconciled imported item is visible by default');
  assert.equal(res.body.items[0].id, item.id);
  assert.equal(res.body.items[0].receipt.sourceTxnId, null);
  assert.equal(res.body.items[0].receipt.date, null);
});

test('GET /api/items with a date filter excludes unmatched items', async () => {
  // The unmatched orphanvendor item (above) has no transaction, so a date filter
  // — which narrows to ledger-reconciled items — must not return it.
  const res = await agentA.get('/api/items?vendor=orphanvendor&from=2000-01-01&to=2100-01-01');
  assert.equal(res.status, 200);
  assert.equal(res.body.items.length, 0, 'date filter is reconciled-only');
});

test('GET /api/items does not duplicate an item with multiple non-rejected links', async () => {
  const { Account, ExternalOrder, ExternalOrderItem, Transaction, TransactionOrderLink } =
    await import('../../src/models/index.js');
  const householdAId = (await agentA.get('/api/auth/me')).body.user.household.id;
  const account = await Account.create({
    householdId: householdAId,
    owner: 'me',
    visibility: 'shared',
    name: 'A Multi Account',
    accountType: 'checking',
  } as never);
  const mkTxn = (batch: string, date: string) =>
    Transaction.create({
      accountId: account.id,
      householdId: householdAId,
      importBatch: batch,
      date,
      merchantRaw: 'Costco',
      merchantClean: 'Costco',
      amount: '-20',
      currency: 'USD',
      sourceRowFingerprint: crypto.randomBytes(16).toString('hex'),
      sourceIdentityFingerprint: crypto.randomBytes(16).toString('hex'),
      visibility: 'shared',
      ownershipType: 'shared',
      finalCategory: null,
      finalBusiness: false,
      finalSplitType: 'none',
      businessAmount: '0',
    } as never);
  const txn1 = await mkTxn('b-multi-1', '2026-04-03');
  const txn2 = await mkTxn('b-multi-2', '2026-04-04');
  const order = await ExternalOrder.create({
    householdId: householdAId,
    vendor: 'multilink',
    dedupeKey: 'multilink-1',
    total: '20',
    currency: 'USD',
    source: 'amazon_report',
  } as never);
  const item = await ExternalOrderItem.create({
    externalOrderId: order.id,
    title: 'split item',
    quantity: 1,
    totalPrice: '20',
  } as never);
  await TransactionOrderLink.create({
    transactionId: txn1.id,
    externalOrderId: order.id,
    confidence: '80.00',
    matchReason: 'test',
    status: 'accepted',
  } as never);
  await TransactionOrderLink.create({
    transactionId: txn2.id,
    externalOrderId: order.id,
    confidence: '70.00',
    matchReason: 'test',
    status: 'suggested',
  } as never);

  const res = await agentA.get('/api/items?vendor=multilink');
  assert.equal(res.status, 200);
  assert.equal(res.body.items.length, 1, 'item with two links must appear exactly once');
  assert.equal(res.body.items[0].id, item.id);
});

test('GET /api/items paginates with cursor', async () => {
  const { Account, ExternalOrder, ExternalOrderItem, Receipt, Transaction } = await import(
    '../../src/models/index.js'
  );
  const householdAId = (await agentA.get('/api/auth/me')).body.user.household.id;
  const account = await Account.create({
    householdId: householdAId,
    owner: 'me',
    visibility: 'shared',
    name: 'A Pag Account',
    accountType: 'checking',
  } as never);
  const txn = await Transaction.create({
    accountId: account.id,
    householdId: householdAId,
    importBatch: 'b-pag',
    date: '2026-05-15',
    merchantRaw: 'X',
    merchantClean: 'X',
    amount: '-100',
    currency: 'USD',
    sourceRowFingerprint: crypto.randomBytes(16).toString('hex'),
    sourceIdentityFingerprint: crypto.randomBytes(16).toString('hex'),
    visibility: 'shared',
    ownershipType: 'shared',
    finalCategory: null,
    finalBusiness: false,
    finalSplitType: 'none',
    businessAmount: '0',
  } as never);
  const order = await ExternalOrder.create({
    householdId: householdAId,
    vendor: 'pagvendor',
    dedupeKey: 'pag-1',
    total: '100',
    currency: 'USD',
    source: 'image',
  } as never);
  await Receipt.create({
    transactionId: txn.id,
    storedFilename: 'p.jpg',
    originalName: 'p.jpg',
    mimeType: 'image/jpeg',
    sizeBytes: 1,
    externalOrderId: order.id,
  } as never);
  await ExternalOrderItem.bulkCreate(
    Array.from({ length: 120 }, (_, i) => ({
      externalOrderId: order.id,
      title: `pag-item-${i}`,
      quantity: 1,
      totalPrice: '1.00',
    })) as never,
  );

  const page1 = await agentA.get('/api/items?vendor=pagvendor&limit=50');
  assert.equal(page1.status, 200);
  assert.equal(page1.body.items.length, 50);
  assert.ok(page1.body.nextCursor);

  const page2 = await agentA.get(
    `/api/items?vendor=pagvendor&limit=50&cursor=${encodeURIComponent(page1.body.nextCursor)}`,
  );
  assert.equal(page2.status, 200);
  assert.equal(page2.body.items.length, 50);
  const page1Ids = new Set(page1.body.items.map((r: { id: number }) => r.id));
  for (const r of page2.body.items) {
    assert.equal(page1Ids.has(r.id), false, 'page 2 must not repeat page 1 ids');
  }

  const page3 = await agentA.get(
    `/api/items?vendor=pagvendor&limit=50&cursor=${encodeURIComponent(page2.body.nextCursor)}`,
  );
  assert.equal(page3.body.items.length, 20);
  assert.equal(page3.body.nextCursor, null);
});

test('GET /api/items?format=csv returns CSV', async () => {
  const res = await agentA.get('/api/items?format=csv&vendor=amazon');
  assert.equal(res.status, 200);
  assert.equal(res.headers['content-type'], 'text/csv; charset=utf-8');
  assert.match(res.headers['content-disposition'] ?? '', /attachment; filename="items-/);
  const lines = res.text.split('\n');
  assert.equal(lines[0], 'id,date,vendor,title,qty,unitPrice,totalPrice,categoryEffective,businessUseEffective');
  assert.ok(lines.length > 1);
});

test('GET /api/items?format=csv escapes quotes and commas', async () => {
  const { Account, ExternalOrder, ExternalOrderItem, Receipt, Transaction } = await import(
    '../../src/models/index.js'
  );
  const householdAId = (await agentA.get('/api/auth/me')).body.user.household.id;
  const account = await Account.create({
    householdId: householdAId,
    owner: 'me',
    visibility: 'shared',
    name: 'A CSV Account',
    accountType: 'checking',
  } as never);
  const order = await ExternalOrder.create({
    householdId: householdAId,
    vendor: 'csv-vendor',
    dedupeKey: 'csv-1',
    total: '5.00',
    currency: 'USD',
    source: 'image',
  } as never);
  const txn = await Transaction.create({
    accountId: account.id,
    householdId: householdAId,
    importBatch: 'b-csv',
    date: '2026-05-22',
    merchantRaw: 'Y',
    merchantClean: 'Y',
    amount: '-5',
    currency: 'USD',
    sourceRowFingerprint: crypto.randomBytes(16).toString('hex'),
    sourceIdentityFingerprint: crypto.randomBytes(16).toString('hex'),
    visibility: 'shared',
    ownershipType: 'shared',
    finalCategory: null,
    finalBusiness: false,
    finalSplitType: 'none',
    businessAmount: '0',
  } as never);
  await Receipt.create({
    transactionId: txn.id,
    storedFilename: 'c.jpg',
    originalName: 'c.jpg',
    mimeType: 'image/jpeg',
    sizeBytes: 1,
    externalOrderId: order.id,
  } as never);
  await ExternalOrderItem.create({
    externalOrderId: order.id,
    title: 'thing, "quoted"',
    quantity: 1,
    totalPrice: '5.00',
  } as never);

  const res = await agentA.get('/api/items?format=csv&vendor=csv-vendor');
  assert.match(res.text, /"thing, ""quoted"""/);
});

test('GET /api/items?format=csv returns 413 above row cap', async () => {
  process.env.ITEMS_CSV_MAX_ROWS = '0';
  const res = await agentA.get('/api/items?format=csv&vendor=amazon');
  delete process.env.ITEMS_CSV_MAX_ROWS;
  assert.equal(res.status, 413);
  assert.match(res.body.error, /too large/i);
});

async function createHouseholdItem(
  agent: ReturnType<typeof request.agent>,
  opts: { vendor: string; dedupeKey: string; itemTitles: string[]; total?: string; date?: string },
): Promise<{ items: { id: number }[] }> {
  const { Account, ExternalOrder, ExternalOrderItem, Receipt, Transaction } = await import(
    '../../src/models/index.js'
  );
  const householdId = (await agent.get('/api/auth/me')).body.user.household.id;
  const account = await Account.create({
    householdId,
    owner: 'me',
    visibility: 'shared',
    name: `Acct ${opts.dedupeKey}`,
    accountType: 'checking',
  } as never);
  const order = await ExternalOrder.create({
    householdId,
    vendor: opts.vendor,
    dedupeKey: opts.dedupeKey,
    total: opts.total ?? '30',
    currency: 'USD',
    source: 'image',
  } as never);
  const txn = await Transaction.create({
    accountId: account.id,
    householdId,
    importBatch: `b-${opts.dedupeKey}`,
    date: opts.date ?? '2026-05-10',
    merchantRaw: 'Z',
    merchantClean: 'Z',
    amount: '-30',
    currency: 'USD',
    sourceRowFingerprint: crypto.randomBytes(16).toString('hex'),
    sourceIdentityFingerprint: crypto.randomBytes(16).toString('hex'),
    visibility: 'shared',
    ownershipType: 'shared',
    finalCategory: null,
    finalBusiness: false,
    finalSplitType: 'none',
    businessAmount: '0',
  } as never);
  await Receipt.create({
    transactionId: txn.id,
    storedFilename: `${opts.dedupeKey}.jpg`,
    originalName: `${opts.dedupeKey}.jpg`,
    mimeType: 'image/jpeg',
    sizeBytes: 1,
    externalOrderId: order.id,
  } as never);
  const items: { id: number }[] = [];
  for (const title of opts.itemTitles) {
    const it = await ExternalOrderItem.create({
      externalOrderId: order.id,
      title,
      quantity: 1,
      totalPrice: '10',
    } as never);
    items.push({ id: it.id });
  }
  return { items };
}

test('POST /api/external-order-items/bulk-patch updates many items', async () => {
  const { ExternalOrderItem } = await import('../../src/models/index.js');
  const { items } = await createHouseholdItem(agentA, {
    vendor: 'bulk',
    dedupeKey: 'bulk-1',
    itemTitles: ['a', 'b', 'c'],
  });

  const res = await agentA
    .post('/api/external-order-items/bulk-patch')
    .send({ itemIds: items.map((i) => i.id), categoryOverride: 'Office' });
  assert.equal(res.status, 200);
  assert.equal(res.body.updated, 3);

  for (const i of items) {
    const fresh = await ExternalOrderItem.findByPk(i.id);
    assert.equal(fresh?.categoryOverride, 'Office');
  }
});

test('POST /api/external-order-items/bulk-patch rejects empty itemIds', async () => {
  const res = await agentA
    .post('/api/external-order-items/bulk-patch')
    .send({ itemIds: [], categoryOverride: 'X' });
  assert.equal(res.status, 400);
});

test('POST /api/external-order-items/bulk-patch rejects >200 itemIds', async () => {
  const ids = Array.from({ length: 201 }, (_, i) => i + 1);
  const res = await agentA
    .post('/api/external-order-items/bulk-patch')
    .send({ itemIds: ids, categoryOverride: 'X' });
  assert.equal(res.status, 400);
});

test('POST /api/external-order-items/bulk-patch blocks cross-household', async () => {
  const { ExternalOrderItem } = await import('../../src/models/index.js');
  const { items } = await createHouseholdItem(agentA, {
    vendor: 'priv',
    dedupeKey: 'priv-1',
    itemTitles: ['secret'],
  });

  const res = await agentB
    .post('/api/external-order-items/bulk-patch')
    .send({ itemIds: items.map((i) => i.id), categoryOverride: 'Z' });
  assert.equal(res.status, 403);

  const fresh = await ExternalOrderItem.findByPk(items[0].id);
  assert.equal(fresh?.categoryOverride, null);
});

test('GET /api/items/:id/allocation returns allocation for linked item', async () => {
  const { Account, ExternalOrder, ExternalOrderItem, Receipt, Transaction } = await import(
    '../../src/models/index.js'
  );
  const householdAId = (await agentA.get('/api/auth/me')).body.user.household.id;
  const account = await Account.create({
    householdId: householdAId,
    owner: 'me',
    visibility: 'shared',
    name: 'Alloc Acct',
    accountType: 'checking',
  } as never);
  const order = await ExternalOrder.create({
    householdId: householdAId,
    vendor: 'alloc',
    dedupeKey: 'alloc-1',
    subtotal: '40',
    tax: '2',
    shipping: '0',
    total: '42',
    currency: 'USD',
    source: 'image',
  } as never);
  const txn = await Transaction.create({
    accountId: account.id,
    householdId: householdAId,
    importBatch: 'b-alloc',
    date: '2026-05-05',
    merchantRaw: 'Q',
    merchantClean: 'Q',
    amount: '-42',
    currency: 'USD',
    sourceRowFingerprint: crypto.randomBytes(16).toString('hex'),
    sourceIdentityFingerprint: crypto.randomBytes(16).toString('hex'),
    visibility: 'shared',
    ownershipType: 'shared',
    finalCategory: 'Office',
    finalBusiness: false,
    finalSplitType: 'none',
    businessAmount: '0',
  } as never);
  await Receipt.create({
    transactionId: txn.id,
    storedFilename: 'a.jpg',
    originalName: 'a.jpg',
    mimeType: 'image/jpeg',
    sizeBytes: 1,
    externalOrderId: order.id,
  } as never);
  const item = await ExternalOrderItem.create({
    externalOrderId: order.id,
    title: 'alloc-thing',
    quantity: 1,
    totalPrice: '40',
    inferredCategory: 'Office',
  } as never);

  const res = await agentA.get(`/api/items/${item.id}/allocation`);
  assert.equal(res.status, 200);
  assert.equal(res.body.itemId, item.id);
  assert.equal(res.body.txnId, txn.id);
  assert.equal(res.body.itemTotal, 40);
  assert.ok(Math.abs(res.body.allocatedTotal - 42) < 0.01);
  assert.equal(res.body.categoryBucket, 'Office');
});

test('GET /api/items/:id/allocation returns null txn for unlinked item', async () => {
  const { ExternalOrder, ExternalOrderItem } = await import('../../src/models/index.js');
  const householdAId = (await agentA.get('/api/auth/me')).body.user.household.id;
  const order = await ExternalOrder.create({
    householdId: householdAId,
    vendor: 'noLink',
    dedupeKey: 'nolink-1',
    total: '10',
    currency: 'USD',
    source: 'image',
  } as never);
  const item = await ExternalOrderItem.create({
    externalOrderId: order.id,
    title: 'orphan',
    quantity: 1,
    totalPrice: '10',
  } as never);

  const res = await agentA.get(`/api/items/${item.id}/allocation`);
  assert.equal(res.status, 200);
  assert.equal(res.body.txnId, null);
  assert.equal(res.body.allocatedTotal, null);
  assert.equal(res.body.itemTotal, 10);
});

test('GET /api/items/:id/allocation blocks cross-household', async () => {
  const { ExternalOrder, ExternalOrderItem } = await import('../../src/models/index.js');
  const householdAId = (await agentA.get('/api/auth/me')).body.user.household.id;
  const order = await ExternalOrder.create({
    householdId: householdAId,
    vendor: 'priv',
    dedupeKey: 'priv-alloc-1',
    total: '5',
    currency: 'USD',
    source: 'image',
  } as never);
  const item = await ExternalOrderItem.create({
    externalOrderId: order.id,
    title: 'secret-alloc',
    quantity: 1,
    totalPrice: '5',
  } as never);
  const res = await agentB.get(`/api/items/${item.id}/allocation`);
  assert.equal(res.status, 403);
});
