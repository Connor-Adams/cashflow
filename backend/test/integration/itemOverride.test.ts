/**
 * Integration tests for PATCH /api/external-order-items/:id
 *
 * Tests:
 *  1. Updates categoryOverride for a household-owned item
 *  2. Returns 404 when item has no household-linked transaction
 *  3. Returns 404 cross-household (id enumeration protection)
 *  4. Rejects businessUseOverride > 100 with 400
 *  5. Accepts null to clear categoryOverride
 *  6. Accepts empty string to clear businessUseOverride (regression guard for commit 686a9b0)
 *  7. Patches both fields independently in one request
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
const dbPath = path.join(backendRoot, 'data', 'test-item-override.sqlite');

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
    email: 'super-item-override@example.com',
    displayName: 'Super User',
    password: 'password123',
  });
  assert.equal(reg.status, 201);

  // Seed household A.
  const a = await seedHousehold('ItemOverrideA', 'A Partner');
  householdAId = a.householdId;
  userAId = a.userId;
  agentA = request.agent(app);
  agentA.jar.setCookie(`cashflow_session=${a.token}; Path=/`);

  // Seed household B.
  const b = await seedHousehold('ItemOverrideB', 'B Partner');
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
    shortCode: 'A-VIS',
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

/** Helper: create a linked ExternalOrder + ExternalOrderItem + Transaction + TransactionOrderLink for household A. */
async function seedLinkedItem(opts: {
  categoryOverride?: string | null;
  businessUseOverride?: string | null;
} = {}): Promise<{ itemId: number; orderId: number; txnId: number }> {
  const txn = await models.Transaction.create({
    accountId: accountAId,
    householdId: householdAId,
    createdByUserId: userAId,
    visibility: 'shared',
    ownershipType: 'me',
    importBatch: 'item-override-test',
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
    myShareAmount: '-47.50',
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

  const order = await models.ExternalOrder.create({
    householdId: householdAId,
    createdByUserId: userAId,
    vendor: 'costco',
    vendorOrderId: null,
    dedupeKey: `test-${crypto.randomBytes(8).toString('hex')}`,
    orderDate: '2026-05-10',
    shipmentDate: null,
    subtotal: '45.50',
    tax: '2.00',
    shipping: null,
    total: '47.50',
    currency: 'CAD',
    paymentLast4: null,
    source: 'receipt-analyze',
    rawPayload: null,
  });

  const item = await models.ExternalOrderItem.create({
    externalOrderId: order.id,
    title: 'Kirkland Olive Oil',
    quantity: 1,
    unitPrice: '15.99',
    totalPrice: '15.99',
    inferredCategory: 'Groceries',
    businessUsePercent: null,
    confidence: null,
    categoryOverride: opts.categoryOverride ?? null,
    businessUseOverride: opts.businessUseOverride ?? null,
    rawPayload: null,
  });

  await models.TransactionOrderLink.create({
    transactionId: txn.id,
    externalOrderId: order.id,
    confidence: '0.95',
    matchReason: 'amount+vendor',
    status: 'suggested',
    linkedAmount: '-47.50',
  });

  return { itemId: item.id, orderId: order.id, txnId: txn.id };
}

// ---------------------------------------------------------------------------
// Test 1: Updates categoryOverride for a household-owned item
// ---------------------------------------------------------------------------

test('PATCH external-order-items: updates categoryOverride for household-owned item', async () => {
  const { itemId } = await seedLinkedItem();

  const res = await agentA
    .patch(`/api/external-order-items/${itemId}`)
    .send({ categoryOverride: 'Groceries' });

  assert.equal(res.status, 200, `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
  assert.equal(res.body.categoryOverride, 'Groceries', 'categoryOverride should be Groceries');

  // Verify persisted in DB.
  const row = await models.ExternalOrderItem.findByPk(itemId);
  assert.equal(row!.categoryOverride, 'Groceries');
});

// ---------------------------------------------------------------------------
// Test 2: Returns 404 when item has no household-linked transaction
// ---------------------------------------------------------------------------

test('PATCH external-order-items: returns 404 when item has no household-linked txn', async () => {
  // Create order + item WITHOUT a TransactionOrderLink.
  const order = await models.ExternalOrder.create({
    householdId: householdAId,
    createdByUserId: userAId,
    vendor: 'costco',
    vendorOrderId: null,
    dedupeKey: `no-link-${crypto.randomBytes(8).toString('hex')}`,
    orderDate: '2026-05-10',
    shipmentDate: null,
    subtotal: null,
    tax: null,
    shipping: null,
    total: null,
    currency: 'CAD',
    paymentLast4: null,
    source: 'receipt-analyze',
    rawPayload: null,
  });

  const item = await models.ExternalOrderItem.create({
    externalOrderId: order.id,
    title: 'Unlinked Item',
    quantity: 1,
    unitPrice: null,
    totalPrice: null,
    inferredCategory: null,
    businessUsePercent: null,
    confidence: null,
    categoryOverride: null,
    businessUseOverride: null,
    rawPayload: null,
  });

  const res = await agentA
    .patch(`/api/external-order-items/${item.id}`)
    .send({ categoryOverride: 'Groceries' });

  assert.equal(res.status, 404, `expected 404, got ${res.status}: ${JSON.stringify(res.body)}`);
});

// ---------------------------------------------------------------------------
// Test 3: Returns 404 cross-household (id enumeration protection)
// ---------------------------------------------------------------------------

test('PATCH external-order-items: returns 404 cross-household', async () => {
  const { itemId } = await seedLinkedItem();

  // agentB belongs to household B — item is linked to household A.
  const res = await agentB
    .patch(`/api/external-order-items/${itemId}`)
    .send({ categoryOverride: 'Food' });

  assert.equal(res.status, 404, `expected 404 from cross-household access, got ${res.status}: ${JSON.stringify(res.body)}`);
});

// ---------------------------------------------------------------------------
// Test 4: Rejects businessUseOverride > 100 with 400
// ---------------------------------------------------------------------------

test('PATCH external-order-items: rejects businessUseOverride > 100 with 400', async () => {
  const { itemId } = await seedLinkedItem();

  const res = await agentA
    .patch(`/api/external-order-items/${itemId}`)
    .send({ businessUseOverride: 150 });

  assert.equal(res.status, 400, `expected 400, got ${res.status}: ${JSON.stringify(res.body)}`);
});

// ---------------------------------------------------------------------------
// Test 5: Accepts null to clear categoryOverride
// ---------------------------------------------------------------------------

test('PATCH external-order-items: accepts null to clear categoryOverride', async () => {
  const { itemId } = await seedLinkedItem({ categoryOverride: 'Groceries' });

  // Verify initial state.
  const before = await models.ExternalOrderItem.findByPk(itemId);
  assert.equal(before!.categoryOverride, 'Groceries', 'precondition: categoryOverride should be Groceries');

  const res = await agentA
    .patch(`/api/external-order-items/${itemId}`)
    .send({ categoryOverride: null });

  assert.equal(res.status, 200, `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
  assert.equal(res.body.categoryOverride, null, 'categoryOverride should be null after clearing');

  const row = await models.ExternalOrderItem.findByPk(itemId);
  assert.equal(row!.categoryOverride, null);
});

// ---------------------------------------------------------------------------
// Test 6: Accepts empty string to clear businessUseOverride (regression guard for commit 686a9b0)
// ---------------------------------------------------------------------------

test('PATCH external-order-items: accepts empty string to clear businessUseOverride (not "0")', async () => {
  const { itemId } = await seedLinkedItem({ businessUseOverride: '50' });

  // Verify initial state.
  const beforeRow = await models.ExternalOrderItem.findByPk(itemId);
  assert.ok(beforeRow!.businessUseOverride != null, 'precondition: businessUseOverride should be set');

  const res = await agentA
    .patch(`/api/external-order-items/${itemId}`)
    .send({ businessUseOverride: '' });

  assert.equal(res.status, 200, `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
  // The bug fixed by 686a9b0: empty string was storing '0' instead of null.
  assert.equal(res.body.businessUseOverride, null, 'businessUseOverride should be null, not "0"');

  const row = await models.ExternalOrderItem.findByPk(itemId);
  assert.equal(row!.businessUseOverride, null, 'DB businessUseOverride should be null after clearing with empty string');
});

// ---------------------------------------------------------------------------
// Test 7: Patches both fields independently in one request
// ---------------------------------------------------------------------------

test('PATCH external-order-items: patches both fields in one request', async () => {
  const { itemId } = await seedLinkedItem();

  const res = await agentA
    .patch(`/api/external-order-items/${itemId}`)
    .send({ categoryOverride: 'Office Supplies', businessUseOverride: 75 });

  assert.equal(res.status, 200, `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
  assert.equal(res.body.categoryOverride, 'Office Supplies', 'categoryOverride should be Office Supplies');
  // The server stores it as a string (DECIMAL column).
  assert.equal(Number(res.body.businessUseOverride), 75, 'businessUseOverride should be 75');

  const row = await models.ExternalOrderItem.findByPk(itemId);
  assert.equal(row!.categoryOverride, 'Office Supplies');
  assert.equal(Number(row!.businessUseOverride), 75);
});
