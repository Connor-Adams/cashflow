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
import path from 'path';
import fs from 'fs';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import request from 'supertest';
import { seedHousehold } from '../helpers/seedHousehold.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.join(__dirname, '..', '..');
const dbPath = path.join(backendRoot, 'data', 'test-integration-items.sqlite');

let app: import('express').Express;
let superAgent: ReturnType<typeof request.agent>;
let agentA: ReturnType<typeof request.agent>;
let agentB: ReturnType<typeof request.agent>;

before(async () => {
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  process.env.DATABASE_PATH = dbPath;
  process.env.NODE_ENV = 'test';

  execFileSync('yarn', ['run', 'sequelize-cli', 'db:migrate'], {
    cwd: backendRoot,
    env: { ...process.env, DATABASE_PATH: dbPath, NODE_ENV: 'development' },
    stdio: 'pipe',
  });

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

after(() => {
  if (fs.existsSync(dbPath)) {
    try {
      fs.unlinkSync(dbPath);
    } catch {
      /* ignore */
    }
  }
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
