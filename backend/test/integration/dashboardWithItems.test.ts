/**
 * Integration tests for GET /api/summary/dashboard with item-level allocations.
 *
 * Tests:
 *  1. Splits a txn across item categories with pro-rated tax
 *  2. Falls back to txn category when no items are linked
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import request from 'supertest';
import { seedHousehold } from '../helpers/seedHousehold.js';
import { setupPgTestDb, teardownPgTestDb, type PgTestDb } from './_setup/pgTestDb.js';

let app: import('express').Express;
let agent: ReturnType<typeof request.agent>;
let householdId: number;
let userId: number;
let accountId: number;
let models: typeof import('../../src/models/index.js');
let testDb: PgTestDb;

before(async () => {
  testDb = await setupPgTestDb('dashboard-with-items');

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
  await teardownPgTestDb(testDb);
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

// ---------------------------------------------------------------------------
// Test 3: netSpendByBusiness splits one txn across business + personal buckets
// using item-level businessUsePercent. Pre-allocator behavior used the
// row-level finalBusiness boolean which dropped the full amount into a single
// bucket.
// ---------------------------------------------------------------------------

test('dashboard: netSpendByBusiness splits across buckets via item business%', async () => {
  const txn = await models.Transaction.create({
    accountId,
    householdId,
    createdByUserId: userId,
    visibility: 'shared',
    ownershipType: 'me',
    importBatch: 'dashboard-items-test',
    date: '2026-05-22',
    merchantRaw: `STAPLES-${crypto.randomBytes(4).toString('hex')}`,
    merchantClean: 'Staples',
    merchantCanonical: null,
    amount: '-100.00',
    currency: 'CAD',
    notes: null,
    sourceReference: null,
    sourceRowFingerprint: crypto.randomBytes(16).toString('hex'),
    sourceIdentityFingerprint: crypto.randomBytes(16).toString('hex'),
    appliedRuleId: null,
    autoCategory: null,
    categoryOverride: null,
    finalCategory: 'Office',
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
    myShareAmount: '-100.00',
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
    householdId,
    createdByUserId: userId,
    vendor: 'staples',
    vendorOrderId: null,
    dedupeKey: `di-biz-${crypto.randomBytes(8).toString('hex')}`,
    orderDate: '2026-05-22',
    shipmentDate: null,
    subtotal: '100.00',
    tax: '0',
    shipping: null,
    total: '100.00',
    currency: 'CAD',
    paymentLast4: null,
    source: 'receipt-analyze',
    rawPayload: null,
  });

  // Printer paper: $60, 100% business use.
  await models.ExternalOrderItem.create({
    externalOrderId: order.id,
    title: 'Printer paper',
    quantity: 1,
    unitPrice: '60.00',
    totalPrice: '60.00',
    inferredCategory: 'Office',
    businessUsePercent: '100',
    confidence: null,
    categoryOverride: null,
    businessUseOverride: null,
    rawPayload: null,
  });

  // Snacks: $40, 0% business use (personal).
  await models.ExternalOrderItem.create({
    externalOrderId: order.id,
    title: 'Snacks',
    quantity: 1,
    unitPrice: '40.00',
    totalPrice: '40.00',
    inferredCategory: 'Groceries',
    businessUsePercent: '0',
    confidence: null,
    categoryOverride: null,
    businessUseOverride: null,
    rawPayload: null,
  });

  await models.TransactionOrderLink.create({
    transactionId: txn.id,
    externalOrderId: order.id,
    confidence: '95',
    matchReason: 'test',
    status: 'confirmed',
    linkedAmount: '100.00',
  });

  const res = await agent
    .get('/api/summary/dashboard')
    .query({ currency: 'CAD', dateFrom: '2026-05-22', dateTo: '2026-05-22' });

  assert.equal(res.status, 200, `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);

  const byBiz = res.body.netSpendByBusiness as Array<{
    currency: string;
    business: boolean;
    totalSpend: number;
    totalCredits: number;
    netSpend: number;
  }>;
  assert.ok(Array.isArray(byBiz), 'netSpendByBusiness must be an array');

  const biz = byBiz.find((b) => b.currency === 'CAD' && b.business === true);
  const personal = byBiz.find((b) => b.currency === 'CAD' && b.business === false);

  assert.ok(biz != null, `expected business=true bucket, got: ${JSON.stringify(byBiz)}`);
  assert.ok(personal != null, `expected business=false bucket, got: ${JSON.stringify(byBiz)}`);
  assert.ok(
    Math.abs(biz.totalSpend - 60) < 0.05,
    `expected business totalSpend ≈ 60, got ${biz.totalSpend}`,
  );
  assert.ok(
    Math.abs(personal.totalSpend - 40) < 0.05,
    `expected personal totalSpend ≈ 40, got ${personal.totalSpend}`,
  );

  // Reconciliation: biz + personal must equal headline netSpend.
  const metrics = res.body.metricsByCurrency as Array<{
    currency: string;
    netSpend: number;
  }>;
  const cad = metrics.find((m) => m.currency === 'CAD');
  assert.ok(cad != null, 'expected CAD metrics row');
  const bizSum = byBiz
    .filter((b) => b.currency === 'CAD')
    .reduce((s, b) => s + b.netSpend, 0);
  assert.ok(
    Math.abs(bizSum - cad.netSpend) < 0.01,
    `business+personal netSpend (${bizSum}) must reconcile with headline (${cad.netSpend})`,
  );
});
