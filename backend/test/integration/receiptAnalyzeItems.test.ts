/**
 * Integration tests for POST /api/receipts/:id/analyze
 *
 * Tests:
 *  1. Persists ExternalOrder + items and links receipt to transaction
 *  2. Re-analyze on same receipt is dedup'd via persistExtractedOrder dedupeKey
 *  3. Returns 503 when OpenAI is not configured
 *  4. Returns 404 when receipt belongs to another household
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import request from 'supertest';
import { testAgent } from './_setup/testServer.js';
import { seedHousehold } from '../helpers/seedHousehold.js';
import { setupPgTestDb, teardownPgTestDb, type PgTestDb } from './_setup/pgTestDb.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.join(__dirname, '..', '..');
const receiptsUploadDir = path.join(backendRoot, 'uploads', 'test-receipt-analyze');

let app: import('express').Express;
let agentA: ReturnType<typeof request.agent>;
let agentB: ReturnType<typeof request.agent>;
let householdAId: number;
let userAId: number;
let accountAId: number;
let models: typeof import('../../src/models/index.js');
let testDb: PgTestDb;

// Minimal 1x1 PNG
const fakePng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lz9ncwAAAABJRU5ErkJggg==',
  'base64',
);

/** Build a canned ExtractedReceiptOrder JSON string for stubbing fetch. */
function cannedOrderJson(opts: { items?: number; total?: number; orderId?: string; orderDate?: string } = {}) {
  const itemCount = opts.items ?? 2;
  const total = opts.total ?? 47.50;
  const items = Array.from({ length: itemCount }, (_, i) => ({
    title: `Costco Item ${i + 1}`,
    quantity: 1,
    unitPrice: total / itemCount,
    totalPrice: total / itemCount,
    inferredCategory: 'Groceries',
  }));
  return JSON.stringify({
    vendor: 'costco',
    vendorName: 'Costco Wholesale',
    orderDate: opts.orderDate ?? '2026-05-10',
    orderId: opts.orderId ?? null,
    subtotal: total - 2.0,
    tax: 2.0,
    total,
    currency: 'CAD',
    paymentLast4: null,
    tenders: [],
    items,
    notes: null,
  });
}

/** Stub globalThis.fetch to return a single canned OpenAI chat/completions response. */
function stubFetch(contentJson: string): () => void {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => ({
    ok: true,
    status: 200,
    headers: new Headers(),
    json: async () => ({
      choices: [{ message: { content: contentJson } }],
    }),
    text: async () => '',
  } as unknown as Response)) as typeof globalThis.fetch;
  return () => {
    globalThis.fetch = originalFetch;
  };
}

before(async () => {
  fs.rmSync(receiptsUploadDir, { recursive: true, force: true });
  fs.mkdirSync(receiptsUploadDir, { recursive: true });

  process.env.NODE_ENV = 'test';
  process.env.RECEIPTS_UPLOAD_DIR = receiptsUploadDir;
  // Ensure OPENAI_API_KEY is set so the analyze endpoint doesn't 503 by default.
  process.env.OPENAI_API_KEY = 'test-key-for-stubbed-requests';

  testDb = await setupPgTestDb('receipt-analyze');

  models = await import('../../src/models/index.js');
  app = (await import('../../src/app.js')).default;

  // Bootstrap a superadmin (required as first user).
  const superAgent = testAgent(app);
  const reg = await superAgent.post('/api/auth/register').send({
    email: 'super-receipt-analyze@example.com',
    displayName: 'Super User',
    password: 'password123',
  });
  assert.equal(reg.status, 201);

  // Seed household A.
  const a = await seedHousehold('ReceiptAnalyzeA', 'A Partner');
  householdAId = a.householdId;
  userAId = a.userId;
  agentA = testAgent(app);
  agentA.jar.setCookie(`cashflow_session=${a.token}; Path=/`);

  // Seed household B.
  const b = await seedHousehold('ReceiptAnalyzeB', 'B Partner');
  agentB = testAgent(app);
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
    shortCode: 'A-VIS',
  });
  accountAId = acct.id;
});

after(async () => {
  await teardownPgTestDb(testDb);
  fs.rmSync(receiptsUploadDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Test 1: Persists ExternalOrder + items and links the receipt
// ---------------------------------------------------------------------------

test('analyze: persists ExternalOrder + items and links receipt and transaction', async () => {
  // Create a Costco transaction with amount matching the canned order total.
  const txn = await models.Transaction.create({
    accountId: accountAId,
    householdId: householdAId,
    createdByUserId: userAId,
    visibility: 'shared',
    ownershipType: 'me',
    importBatch: 'receipt-analyze-test',
    date: '2026-05-10',
    merchantRaw: 'COSTCO WHOLESALE 1234',
    merchantClean: 'Costco Wholesale',
    merchantCanonical: null,
    amount: '-47.50',
    currency: 'CAD',
    notes: null,
    sourceReference: null,
    sourceRowFingerprint: crypto.randomBytes(16).toString('hex'),
    sourceIdentityFingerprint: crypto.randomBytes(16).toString('hex'),
    txnType: 'purchase',
    reviewFlag: true,
    isRecurring: false,
  } as never);

  // Upload a fake receipt image attached to the transaction.
  const uploadRes = await agentA
    .post(`/api/transactions/${txn.id}/receipts`)
    .attach('file', fakePng, { filename: 'costco-receipt.png', contentType: 'image/png' });
  assert.equal(uploadRes.status, 201, `upload status: ${JSON.stringify(uploadRes.body)}`);
  const receiptId = uploadRes.body.id as number;
  assert.ok(receiptId > 0);

  // Stub fetch to return a Costco-like extracted order with 2 items.
  const restore = stubFetch(cannedOrderJson({ items: 2, total: 47.50, orderDate: '2026-05-10' }));
  let analyzeRes: request.Response;
  try {
    analyzeRes = await agentA.post(`/api/receipts/${receiptId}/analyze`);
  } finally {
    restore();
  }

  assert.equal(analyzeRes.status, 200, `analyze status: ${JSON.stringify(analyzeRes.body)}`);
  assert.ok(analyzeRes.body.order, 'response should have order');
  assert.ok(analyzeRes.body.extracted, 'response should have extracted');
  assert.equal(analyzeRes.body.extracted.items.length, 2, 'extracted should have 2 items');

  // DB: Receipt has externalOrderId set.
  const receipt = await models.Receipt.findByPk(receiptId);
  assert.ok(receipt, 'receipt should exist');
  assert.ok(receipt!.externalOrderId != null, 'receipt.externalOrderId should be set');

  // DB: Receipt has extractedNote with expected shape.
  const reloaded = await models.Receipt.findByPk(receiptId);
  assert.ok(reloaded!.extractedNote, 'receipt.extractedNote should be set');
  const extractedData = JSON.parse(reloaded!.extractedNote!);
  assert.equal(extractedData.vendor, 'costco', 'extracted order vendor should be costco');

  // DB: ExternalOrder total matches.
  const order = await models.ExternalOrder.findByPk(receipt!.externalOrderId!);
  assert.ok(order, 'ExternalOrder should exist');
  assert.equal(Number(order!.total), 47.50, 'ExternalOrder.total should be 47.50');

  // DB: 2 ExternalOrderItem rows.
  const items = await models.ExternalOrderItem.findAll({ where: { externalOrderId: order!.id } });
  assert.equal(items.length, 2, 'should have 2 ExternalOrderItem rows');

  // DB: At least one TransactionOrderLink for the order (matcher should have linked the Costco txn).
  const links = await models.TransactionOrderLink.findAll({ where: { externalOrderId: order!.id } });
  assert.ok(links.length >= 1, `should have at least 1 TransactionOrderLink, got ${links.length}`);
  assert.equal(links[0].transactionId, txn.id, 'matched link should reference the correct transaction');
});

// ---------------------------------------------------------------------------
// Test 2: Re-analyze on same receipt is dedup'd — no duplicate items
// ---------------------------------------------------------------------------

test('analyze: re-analyze on same receipt is dedup\'d via dedupeKey (no duplicate ExternalOrderItem rows)', async () => {
  // Create a separate transaction for this test.
  const txn = await models.Transaction.create({
    accountId: accountAId,
    householdId: householdAId,
    createdByUserId: userAId,
    visibility: 'shared',
    ownershipType: 'me',
    importBatch: 'receipt-analyze-dedup',
    date: '2026-05-11',
    merchantRaw: 'COSTCO WHOLESALE 9999',
    merchantClean: 'Costco Wholesale',
    merchantCanonical: null,
    amount: '-30.00',
    currency: 'CAD',
    notes: null,
    sourceReference: null,
    sourceRowFingerprint: crypto.randomBytes(16).toString('hex'),
    sourceIdentityFingerprint: crypto.randomBytes(16).toString('hex'),
    txnType: 'purchase',
    reviewFlag: true,
    isRecurring: false,
  } as never);

  const uploadRes = await agentA
    .post(`/api/transactions/${txn.id}/receipts`)
    .attach('file', fakePng, { filename: 'costco-receipt2.png', contentType: 'image/png' });
  assert.equal(uploadRes.status, 201);
  const receiptId = uploadRes.body.id as number;

  // The canned order has no orderId, so dedupeKey is based on vendor + orderDate + total + itemCount.
  // Both calls use the same canned payload → same dedupeKey → findOrCreate returns existing on second call.
  const cannedJson = cannedOrderJson({ items: 2, total: 30.00, orderDate: '2026-05-11' });

  // First analyze call.
  const restore1 = stubFetch(cannedJson);
  let firstRes: request.Response;
  try {
    firstRes = await agentA.post(`/api/receipts/${receiptId}/analyze`);
  } finally {
    restore1();
  }
  assert.equal(firstRes.status, 200, `first analyze status: ${JSON.stringify(firstRes.body)}`);
  const orderId = firstRes.body.order.id as number;

  // Second analyze call with same payload.
  const restore2 = stubFetch(cannedJson);
  let secondRes: request.Response;
  try {
    secondRes = await agentA.post(`/api/receipts/${receiptId}/analyze`);
  } finally {
    restore2();
  }
  assert.equal(secondRes.status, 200, `second analyze status: ${JSON.stringify(secondRes.body)}`);
  // The same order should be returned (dedup'd).
  assert.equal(secondRes.body.order.id, orderId, 'second call should return the same order (dedup)');

  // Crucially: items should NOT be doubled.
  const items = await models.ExternalOrderItem.findAll({ where: { externalOrderId: orderId } });
  assert.equal(items.length, 2, `expected exactly 2 items after re-analyze, got ${items.length}`);
});

// ---------------------------------------------------------------------------
// Test 3: Returns 503 when OPENAI_API_KEY is not configured
// ---------------------------------------------------------------------------

test('analyze: returns 503 when OPENAI_API_KEY is not set', async () => {
  // Create a transaction + upload receipt for this test.
  const txn = await models.Transaction.create({
    accountId: accountAId,
    householdId: householdAId,
    createdByUserId: userAId,
    visibility: 'shared',
    ownershipType: 'me',
    importBatch: 'receipt-analyze-503',
    date: '2026-05-12',
    merchantRaw: 'COSTCO WHOLESALE 5555',
    merchantClean: 'Costco Wholesale',
    merchantCanonical: null,
    amount: '-20.00',
    currency: 'CAD',
    notes: null,
    sourceReference: null,
    sourceRowFingerprint: crypto.randomBytes(16).toString('hex'),
    sourceIdentityFingerprint: crypto.randomBytes(16).toString('hex'),
    txnType: 'purchase',
    reviewFlag: true,
    isRecurring: false,
  } as never);

  const uploadRes = await agentA
    .post(`/api/transactions/${txn.id}/receipts`)
    .attach('file', fakePng, { filename: 'r503.png', contentType: 'image/png' });
  assert.equal(uploadRes.status, 201);
  const receiptId = uploadRes.body.id as number;

  // Save and unset OPENAI_API_KEY.
  const savedKey = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  let analyzeRes: request.Response;
  try {
    analyzeRes = await agentA.post(`/api/receipts/${receiptId}/analyze`);
  } finally {
    if (savedKey !== undefined) {
      process.env.OPENAI_API_KEY = savedKey;
    } else {
      delete process.env.OPENAI_API_KEY;
    }
  }

  assert.equal(analyzeRes.status, 503, `expected 503, got ${analyzeRes.status}: ${JSON.stringify(analyzeRes.body)}`);

  // Receipt should be unchanged (no externalOrderId set).
  const receipt = await models.Receipt.findByPk(receiptId);
  assert.ok(receipt, 'receipt should still exist');
  assert.equal(receipt!.externalOrderId, null, 'receipt.externalOrderId should still be null');
});

// ---------------------------------------------------------------------------
// Test 4: Returns 404 when receipt belongs to another household
// ---------------------------------------------------------------------------

test('analyze: returns 404 when receipt belongs to household A but household B requests it', async () => {
  // Create a transaction + upload receipt for household A.
  const txn = await models.Transaction.create({
    accountId: accountAId,
    householdId: householdAId,
    createdByUserId: userAId,
    visibility: 'shared',
    ownershipType: 'me',
    importBatch: 'receipt-analyze-404',
    date: '2026-05-13',
    merchantRaw: 'COSTCO WHOLESALE 7777',
    merchantClean: 'Costco Wholesale',
    merchantCanonical: null,
    amount: '-15.00',
    currency: 'CAD',
    notes: null,
    sourceReference: null,
    sourceRowFingerprint: crypto.randomBytes(16).toString('hex'),
    sourceIdentityFingerprint: crypto.randomBytes(16).toString('hex'),
    txnType: 'purchase',
    reviewFlag: true,
    isRecurring: false,
  } as never);

  // Upload receipt as household A.
  const uploadRes = await agentA
    .post(`/api/transactions/${txn.id}/receipts`)
    .attach('file', fakePng, { filename: 'r404.png', contentType: 'image/png' });
  assert.equal(uploadRes.status, 201);
  const receiptId = uploadRes.body.id as number;

  // Attempt to analyze as household B — should get 404 (can't see the transaction).
  const analyzeRes = await agentB.post(`/api/receipts/${receiptId}/analyze`);
  assert.equal(analyzeRes.status, 404, `expected 404, got ${analyzeRes.status}: ${JSON.stringify(analyzeRes.body)}`);
});
