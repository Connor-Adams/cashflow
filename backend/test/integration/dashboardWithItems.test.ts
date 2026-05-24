/**
 * Integration tests for GET /api/summary/dashboard with item-level allocations.
 *
 * Tests:
 *  1. Splits a txn across item categories with pro-rated tax
 *  2. Falls back to txn category when no items are linked
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
const dbPath = path.join(backendRoot, 'data', 'test-dashboard-with-items.sqlite');

let app: import('express').Express;
let agent: ReturnType<typeof request.agent>;
let householdId: number;
let userId: number;
let accountId: number;
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
    email: 'super-dashboard-items@example.com',
    displayName: 'Super User',
    password: 'password123',
  });
  assert.equal(reg.status, 201);

  // Seed one household.
  const h = await seedHousehold('DashboardItemsA', 'A Partner');
  householdId = h.householdId;
  userId = h.userId;
  agent = request.agent(app);
  agent.jar.setCookie(`cashflow_session=${h.token}; Path=/`);

  // Create an account for the household.
  const acct = await models.Account.create({
    householdId,
    ownerUserId: userId,
    owner: 'me',
    visibility: 'shared',
    name: 'A Visa',
    accountType: 'credit_card',
    defaultCurrency: 'CAD',
    shortCode: 'DI-VIS',
  });
  accountId = acct.id;
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

// ---------------------------------------------------------------------------
// Test 1: Splits a txn across item categories with pro-rated tax
// ---------------------------------------------------------------------------

test('dashboard: splits txn across item categories with pro-rated tax', async () => {
  // Seed transaction: -105.00 CAD, category Shopping, merchant COSTCO.
  const txn = await models.Transaction.create({
    accountId,
    householdId,
    createdByUserId: userId,
    visibility: 'shared',
    ownershipType: 'me',
    importBatch: 'dashboard-items-test',
    date: '2026-05-20',
    merchantRaw: `COSTCO-${crypto.randomBytes(4).toString('hex')}`,
    merchantClean: 'Costco',
    merchantCanonical: null,
    amount: '-105.00',
    currency: 'CAD',
    notes: null,
    sourceReference: null,
    sourceRowFingerprint: crypto.randomBytes(16).toString('hex'),
    sourceIdentityFingerprint: crypto.randomBytes(16).toString('hex'),
    appliedRuleId: null,
    autoCategory: null,
    categoryOverride: null,
    finalCategory: 'Shopping',
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
    myShareAmount: '-105.00',
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

  // Seed ExternalOrder: subtotal 100, tax 5, total 105.
  const order = await models.ExternalOrder.create({
    householdId,
    createdByUserId: userId,
    vendor: 'costco',
    vendorOrderId: null,
    dedupeKey: `di-test-${crypto.randomBytes(8).toString('hex')}`,
    orderDate: '2026-05-20',
    shipmentDate: null,
    subtotal: '100.00',
    tax: '5.00',
    shipping: null,
    total: '105.00',
    currency: 'CAD',
    paymentLast4: null,
    source: 'receipt-analyze',
    rawPayload: null,
  });

  // Seed items.
  await models.ExternalOrderItem.create({
    externalOrderId: order.id,
    title: 'Eggs',
    quantity: 1,
    unitPrice: '60.00',
    totalPrice: '60.00',
    inferredCategory: 'Groceries',
    businessUsePercent: null,
    confidence: null,
    categoryOverride: null,
    businessUseOverride: null,
    rawPayload: null,
  });

  await models.ExternalOrderItem.create({
    externalOrderId: order.id,
    title: 'Soap',
    quantity: 1,
    unitPrice: '40.00',
    totalPrice: '40.00',
    inferredCategory: 'Cleaning',
    businessUsePercent: null,
    confidence: null,
    categoryOverride: 'Household',
    businessUseOverride: null,
    rawPayload: null,
  });

  // Seed TransactionOrderLink.
  await models.TransactionOrderLink.create({
    transactionId: txn.id,
    externalOrderId: order.id,
    confidence: '95',
    matchReason: 'test',
    status: 'confirmed',
    linkedAmount: '105.00',
  });

  const res = await agent
    .get('/api/summary/dashboard')
    .query({ currency: 'CAD', dateFrom: '2026-05-20', dateTo: '2026-05-20' });

  assert.equal(res.status, 200, `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);

  const categoryReports = res.body.categoryReports as Array<{
    currency: string;
    category: string | null;
    totalSpend: number;
    totalCredits: number;
    netSpend: number;
  }>;

  assert.ok(Array.isArray(categoryReports), 'categoryReports must be an array');

  // Groceries: Eggs 60 + (60/100)*5 = 63
  const groceries = categoryReports.find(
    (r) => r.category === 'Groceries' && r.currency === 'CAD',
  );
  assert.ok(
    groceries != null,
    `expected a Groceries entry in categoryReports, got: ${JSON.stringify(categoryReports)}`,
  );
  assert.ok(
    Math.abs(groceries.totalSpend - 63) < 0.05,
    `expected Groceries totalSpend ≈ 63, got ${groceries.totalSpend}`,
  );

  // Household: Soap 40 + (40/100)*5 = 42
  const household = categoryReports.find(
    (r) => r.category === 'Household' && r.currency === 'CAD',
  );
  assert.ok(
    household != null,
    `expected a Household entry in categoryReports, got: ${JSON.stringify(categoryReports)}`,
  );
  assert.ok(
    Math.abs(household.totalSpend - 42) < 0.05,
    `expected Household totalSpend ≈ 42, got ${household.totalSpend}`,
  );

  // Shopping must NOT appear (item overrides replaced it).
  const shopping = categoryReports.find(
    (r) => r.category === 'Shopping' && r.currency === 'CAD',
  );
  assert.equal(
    shopping,
    undefined,
    `Shopping category should not appear when items override it, got: ${JSON.stringify(categoryReports)}`,
  );
});

// ---------------------------------------------------------------------------
// Test 2: Falls back to txn category when no items are linked
// ---------------------------------------------------------------------------

test('dashboard: falls back to txn category when no items linked', async () => {
  // Seed transaction: -50.00 CAD, category Dining. No order, no link.
  await models.Transaction.create({
    accountId,
    householdId,
    createdByUserId: userId,
    visibility: 'shared',
    ownershipType: 'me',
    importBatch: 'dashboard-items-test',
    date: '2026-05-21',
    merchantRaw: `RESTAURANT-${crypto.randomBytes(4).toString('hex')}`,
    merchantClean: 'Restaurant',
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
    finalCategory: 'Dining',
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

  const res = await agent
    .get('/api/summary/dashboard')
    .query({ currency: 'CAD', dateFrom: '2026-05-21', dateTo: '2026-05-21' });

  assert.equal(res.status, 200, `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);

  const categoryReports = res.body.categoryReports as Array<{
    currency: string;
    category: string | null;
    totalSpend: number;
  }>;

  assert.ok(Array.isArray(categoryReports), 'categoryReports must be an array');

  const dining = categoryReports.find(
    (r) => r.category === 'Dining' && r.currency === 'CAD',
  );
  assert.ok(
    dining != null,
    `expected a Dining entry in categoryReports, got: ${JSON.stringify(categoryReports)}`,
  );
  assert.ok(
    Math.abs(dining.totalSpend - 50) < 0.05,
    `expected Dining totalSpend ≈ 50, got ${dining.totalSpend}`,
  );
});
