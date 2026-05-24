/**
 * Integration tests for GET /api/transactions/:transactionId/receipts
 * (with ExternalOrder + items extension)
 *
 * Tests:
 *  1. Receipt WITHOUT externalOrderId returns items:[] and order:null
 *  2. Receipt WITH externalOrderId returns populated items[] and order object
 *  3. Multiple receipts on one txn: one with order, one without
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
const dbPath = path.join(backendRoot, 'data', 'test-receipts-with-items.sqlite');

let app: import('express').Express;
let agentA: ReturnType<typeof request.agent>;
let agentB: ReturnType<typeof request.agent>;
let householdAId: number;
let userAId: number;
let accountAId: number;
let models: typeof import('../../src/models/index.js');

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

  models = await import('../../src/models/index.js');
  app = (await import('../../src/app.js')).default;

  // Bootstrap a superadmin (required as first user).
  const superAgent = request.agent(app);
  const reg = await superAgent.post('/api/auth/register').send({
    email: 'super-receipts-items@example.com',
    displayName: 'Super User',
    password: 'password123',
  });
  assert.equal(reg.status, 201);

  // Seed household A.
  const a = await seedHousehold('ReceiptsWithItemsA', 'A Partner');
  householdAId = a.householdId;
  userAId = a.userId;
  agentA = request.agent(app);
  agentA.jar.setCookie(`cashflow_session=${a.token}; Path=/`);

  // Seed household B.
  const b = await seedHousehold('ReceiptsWithItemsB', 'B Partner');
  agentB = request.agent(app);
  agentB.jar.setCookie(`cashflow_session=${b.token}; Path=/`);

  // Create an account for household A.
  const acct = await models.Account.create({
    householdId: householdAId,
    ownerUserId: userAId,
    owner: 'me',
    visibility: 'shared',
    name: 'A Visa',
    accountType: 'credit_card',
    defaultCurrency: 'CAD',
    shortCode: 'RI-VIS',
  });
  accountAId = acct.id;
});

after(async () => {
  try {
    await models?.sequelize.close();
  } catch {
    /* ignore */
  }
  if (fs.existsSync(dbPath)) {
    try { fs.unlinkSync(dbPath); } catch { /* ignore */ }
  }
});

/** Helper: create a Transaction row for household A. */
async function seedTransaction(): Promise<number> {
  const txn = await models.Transaction.create({
    accountId: accountAId,
    householdId: householdAId,
    createdByUserId: userAId,
    visibility: 'shared',
    ownershipType: 'me',
    importBatch: 'receipts-items-test',
    date: '2026-05-15',
    merchantRaw: 'AMAZON.CA',
    merchantClean: 'Amazon',
    merchantCanonical: null,
    amount: '-50.00',
    currency: 'CAD',
    notes: null,
    sourceReference: null,
    sourceRowFingerprint: crypto.randomBytes(16).toString('hex'),
    sourceIdentityFingerprint: crypto.randomBytes(16).toString('hex'),
    appliedRuleId: null,
    autoCategory: null,
    categoryOverride: null,
    finalCategory: null,
    autoBusiness: null,
    businessOverride: null,
    finalBusiness: false,
    autoSplitType: null,
    splitOverride: null,
    finalSplitType: 'me',
    autoPctMe: null,
    pctMeOverride: null,
    finalPctMe: null,
    autoPctPartner: null,
    pctPartnerOverride: null,
    finalPctPartner: null,
    myShareAmount: '-50.00',
    partnerShareAmount: '0',
    businessAmount: '0',
    txnType: 'purchase',
    autoSource: null,
    autoConfidence: null,
    linkedTransactionId: null,
    isRecurring: false,
    reviewFlag: false,
    reviewedAt: null,
  } as never);
  return txn.id;
}

/** Helper: create a Receipt row WITHOUT an externalOrderId. */
async function seedReceiptNoOrder(txnId: number): Promise<number> {
  const row = await models.Receipt.create({
    transactionId: txnId,
    storedFilename: `fake-${crypto.randomUUID()}.jpg`,
    originalName: 'receipt.jpg',
    mimeType: 'image/jpeg',
    sizeBytes: 1024,
    extractedNote: null,
    externalOrderId: null,
  });
  return row.id;
}

/** Helper: create an ExternalOrder + one item + a Receipt linked to that order. */
async function seedReceiptWithOrder(txnId: number): Promise<{
  receiptId: number;
  orderId: number;
  itemId: number;
}> {
  const order = await models.ExternalOrder.create({
    householdId: householdAId,
    createdByUserId: userAId,
    vendor: 'amazon',
    vendorOrderId: null,
    dedupeKey: `ri-test-${crypto.randomBytes(8).toString('hex')}`,
    orderDate: '2026-05-15',
    shipmentDate: null,
    subtotal: '45.0000',
    tax: '5.0000',
    shipping: null,
    total: '50.0000',
    currency: 'CAD',
    paymentLast4: null,
    source: 'receipt-analyze',
    rawPayload: null,
  });

  const item = await models.ExternalOrderItem.create({
    externalOrderId: order.id,
    title: 'Milk',
    quantity: 2,
    unitPrice: '5.0000',
    totalPrice: '10.0000',
    inferredCategory: 'Groceries',
    businessUsePercent: null,
    confidence: null,
    categoryOverride: null,
    businessUseOverride: null,
    rawPayload: null,
  });

  const receipt = await models.Receipt.create({
    transactionId: txnId,
    storedFilename: `fake-${crypto.randomUUID()}.jpg`,
    originalName: 'amazon-receipt.jpg',
    mimeType: 'image/jpeg',
    sizeBytes: 2048,
    extractedNote: null,
    externalOrderId: order.id,
  });

  return { receiptId: receipt.id, orderId: order.id, itemId: item.id };
}

// ---------------------------------------------------------------------------
// Test 1: Receipt WITHOUT externalOrderId returns items:[] and order:null
// ---------------------------------------------------------------------------

test('GET receipts: receipt without externalOrderId has items:[] and order:null', async () => {
  const txnId = await seedTransaction();
  await seedReceiptNoOrder(txnId);

  const res = await agentA.get(`/api/transactions/${txnId}/receipts`);

  assert.equal(res.status, 200, `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
  assert.ok(Array.isArray(res.body), 'body should be an array');
  assert.equal(res.body.length, 1, 'should have 1 receipt');

  const receipt = res.body[0];
  assert.equal(receipt.externalOrderId, null, 'externalOrderId should be null');
  assert.equal(receipt.order, null, 'order should be null');
  assert.ok(Array.isArray(receipt.items), 'items should be an array');
  assert.equal(receipt.items.length, 0, 'items should be empty');
});

// ---------------------------------------------------------------------------
// Test 2: Receipt WITH externalOrderId returns populated items[] and order
// ---------------------------------------------------------------------------

test('GET receipts: receipt with externalOrderId returns order and items', async () => {
  const txnId = await seedTransaction();
  const { orderId } = await seedReceiptWithOrder(txnId);

  const res = await agentA.get(`/api/transactions/${txnId}/receipts`);

  assert.equal(res.status, 200, `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
  assert.ok(Array.isArray(res.body), 'body should be an array');
  assert.equal(res.body.length, 1, 'should have 1 receipt');

  const receipt = res.body[0];
  assert.equal(receipt.externalOrderId, orderId, 'externalOrderId should match order');

  // Verify order shape.
  assert.ok(receipt.order !== null, 'order should not be null');
  assert.equal(receipt.order.id, orderId);
  assert.equal(receipt.order.vendor, 'amazon');
  assert.equal(receipt.order.currency, 'CAD');
  // DECIMAL columns come back as strings from SQLite/Sequelize (may be '50' or '50.0000' depending on driver).
  assert.equal(Number(receipt.order.total), 50, `expected order.total to equal 50, got '${receipt.order.total}'`);

  // Verify items.
  assert.ok(Array.isArray(receipt.items), 'items should be an array');
  assert.equal(receipt.items.length, 1, 'should have 1 item');
  const item = receipt.items[0];
  assert.equal(item.title, 'Milk');
  assert.equal(item.quantity, 2);
  assert.equal(item.externalOrderId, orderId);
  assert.equal(Number(item.unitPrice), 5, `expected unitPrice 5, got '${item.unitPrice}'`);
  assert.equal(Number(item.totalPrice), 10, `expected totalPrice 10, got '${item.totalPrice}'`);
  assert.equal(item.inferredCategory, 'Groceries');
  assert.equal(item.categoryOverride, null);
  assert.equal(item.businessUseOverride, null);
});

// ---------------------------------------------------------------------------
// Test 3: Multiple receipts on one txn: one with order, one without
// ---------------------------------------------------------------------------

test('GET receipts: multiple receipts — only one with order has items', async () => {
  const txnId = await seedTransaction();
  const { orderId } = await seedReceiptWithOrder(txnId);
  await seedReceiptNoOrder(txnId);

  const res = await agentA.get(`/api/transactions/${txnId}/receipts`);

  assert.equal(res.status, 200, `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
  assert.ok(Array.isArray(res.body), 'body should be an array');
  assert.equal(res.body.length, 2, 'should have 2 receipts');

  // Receipts are ordered by createdAt DESC, so the no-order one is first.
  const withoutOrder = res.body.find((r: { externalOrderId: number | null }) => r.externalOrderId === null);
  const withOrder = res.body.find((r: { externalOrderId: number | null }) => r.externalOrderId === orderId);

  assert.ok(withoutOrder, 'should have a receipt without order');
  assert.equal(withoutOrder.order, null, 'receipt without order should have order:null');
  assert.ok(Array.isArray(withoutOrder.items), 'items should be array');
  assert.equal(withoutOrder.items.length, 0, 'receipt without order should have items:[]');

  assert.ok(withOrder, 'should have a receipt with order');
  assert.ok(withOrder.order !== null, 'receipt with order should have order object');
  assert.ok(Array.isArray(withOrder.items), 'items should be array');
  assert.equal(withOrder.items.length, 1, 'receipt with order should have 1 item');
  assert.equal(withOrder.items[0].title, 'Milk');
});

// ---------------------------------------------------------------------------
// Test 4: Cross-household access returns 404
// ---------------------------------------------------------------------------

test('GET receipts: cross-household access returns 404', async () => {
  // Seed a transaction + receipt in household A.
  const txnId = await seedTransaction();
  await seedReceiptNoOrder(txnId);

  // agentB belongs to household B — txn is in household A.
  const res = await agentB.get(`/api/transactions/${txnId}/receipts`);

  assert.equal(res.status, 404, `expected 404 from cross-household access, got ${res.status}: ${JSON.stringify(res.body)}`);
});
