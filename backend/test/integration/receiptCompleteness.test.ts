/**
 * Integration tests for receipt-completeness API (#209).
 *
 *   GET /api/receipts/completeness?filter=all|business|tax-relevant&currency=CAD
 *   GET /api/receipts/missing?filter=all|business|tax-relevant&currency=CAD&limit=...
 *
 * Eligibility = spend rows only (negative amount, not in NON_SPEND_TXN_TYPES).
 * Coverage = withReceipt / total, both by count and by absolute dollar amount.
 * Tax-relevant = finalBusiness=true OR finalCategory matches a TaxCategory.label
 *   with isDeductible=true.
 *
 * Mirrors backend/test/integration/budgets.test.ts pattern: pg test db,
 * superadmin bootstrap, two non-superadmin households seeded so cross-household
 * isolation can be exercised via real session cookies.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import request from 'supertest';
import { setupPgTestDb, teardownPgTestDb, type PgTestDb } from './_setup/pgTestDb.js';

let app: import('express').Express;
let primaryAgent: ReturnType<typeof request.agent>;
let primaryHouseholdId: number;
let otherAgent: ReturnType<typeof request.agent>;
let otherHouseholdId: number;
let primaryAccountId: number;
let otherAccountId: number;
let testDb: PgTestDb;

type Seeded = { token: string; householdId: number; userId: number; accountId: number };

async function seed(emailPrefix: string): Promise<Seeded> {
  const models = await import('../../src/models');
  const { hashPassword, hashToken } = await import('../../src/auth/password.js');
  const password = await hashPassword('password123');
  const user = await models.User.create({
    email: `${emailPrefix}-${Date.now()}-${Math.random().toString(16).slice(2)}@example.com`,
    displayName: emailPrefix,
    globalRole: 'user',
    passwordHash: password.hash,
    passwordSalt: password.salt,
    passwordParams: password.params,
  });
  const household = await models.Household.create({ name: `${emailPrefix} household` });
  await models.HouseholdMember.create({
    householdId: household.id,
    userId: user.id,
    role: 'owner',
  });
  const account = await models.Account.create({
    householdId: household.id,
    ownerUserId: user.id,
    owner: 'me',
    visibility: 'shared',
    name: `${emailPrefix} card`,
    accountType: 'credit',
    defaultCurrency: 'CAD',
    shortCode: emailPrefix.slice(0, 3).toUpperCase(),
  });
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24);
  await models.Session.create({
    userId: user.id,
    tokenHash: hashToken(token),
    expiresAt,
  });
  return { token, householdId: household.id, userId: user.id, accountId: account.id };
}

type TxOverrides = {
  visibility?: string;
  ownershipType?: string;
  finalBusiness?: boolean;
  finalCategory?: string | null;
  txnType?: string;
};

async function createTransaction(
  householdId: number,
  accountId: number,
  date: string,
  category: string | null,
  amount: number,
  currency = 'CAD',
  overrides: TxOverrides = {}
): Promise<number> {
  const models = await import('../../src/models');
  const row = await models.Transaction.create({
    accountId,
    householdId,
    visibility: overrides.visibility ?? 'shared',
    ownershipType: overrides.ownershipType ?? 'me',
    ownershipContactId: null,
    importBatch: 'rc-test',
    date,
    merchantRaw: 'Test Merchant',
    merchantClean: 'Test Merchant',
    amount: amount.toFixed(4),
    currency,
    notes: null,
    sourceReference: null,
    sourceRowFingerprint: crypto.randomBytes(16).toString('hex'),
    sourceIdentityFingerprint: crypto.randomBytes(16).toString('hex'),
    appliedRuleId: null,
    autoCategory: null,
    categoryOverride: null,
    finalCategory: overrides.finalCategory ?? category,
    autoBusiness: null,
    businessOverride: null,
    finalBusiness: overrides.finalBusiness ?? false,
    autoSplitType: null,
    splitOverride: null,
    autoPctMe: null,
    pctMeOverride: null,
    finalPctMe: null,
    autoPctPartner: null,
    pctPartnerOverride: null,
    finalPctPartner: null,
    reviewFlag: false,
    reviewedAt: null,
    createdByUserId: null,
    txnType: overrides.txnType ?? 'purchase',
  });
  return row.id;
}

async function attachReceipt(transactionId: number, originalName = 'r.jpg'): Promise<number> {
  const models = await import('../../src/models');
  const row = await models.Receipt.create({
    transactionId,
    storedFilename: `${crypto.randomBytes(8).toString('hex')}.jpg`,
    originalName,
    mimeType: 'image/jpeg',
    sizeBytes: 12345,
    extractedNote: null,
  });
  return row.id;
}

before(async () => {
  testDb = await setupPgTestDb('rcomplete');

  const mod = await import('../../src/app.js');
  app = mod.default;

  const bootstrap = request.agent(app);
  const register = await bootstrap.post('/api/auth/register').send({
    email: 'superadmin@example.com',
    displayName: 'Super Admin',
    password: 'password123',
  });
  assert.equal(register.status, 201);

  const primary = await seed('Primary');
  primaryHouseholdId = primary.householdId;
  primaryAccountId = primary.accountId;
  primaryAgent = request.agent(app);
  primaryAgent.jar.setCookie(`cashflow_session=${primary.token}; Path=/`);

  const other = await seed('Other');
  otherHouseholdId = other.householdId;
  otherAccountId = other.accountId;
  otherAgent = request.agent(app);
  otherAgent.jar.setCookie(`cashflow_session=${other.token}; Path=/`);
});

after(async () => {
  await teardownPgTestDb(testDb);
});

test('GET /api/receipts/completeness aggregates by COUNT and AMOUNT for all spend', async () => {
  // Seed for primary household: 4 spend txns ($100, $200, $300, $50 = $650 abs),
  // 2 of them have receipts ($100 + $300 = $400 covered).
  // Also seed a refund ($25 positive) and a transfer (-$1000) — both excluded.
  const t1 = await createTransaction(primaryHouseholdId, primaryAccountId, '2026-05-01', 'Groceries', -100);
  const t2 = await createTransaction(primaryHouseholdId, primaryAccountId, '2026-05-02', 'Groceries', -200);
  const t3 = await createTransaction(primaryHouseholdId, primaryAccountId, '2026-05-03', 'Travel', -300);
  await createTransaction(primaryHouseholdId, primaryAccountId, '2026-05-04', 'Coffee', -50);
  // Excluded: positive amount (refund-like)
  await createTransaction(primaryHouseholdId, primaryAccountId, '2026-05-05', 'Refund', 25);
  // Excluded: txnType=transfer
  await createTransaction(
    primaryHouseholdId,
    primaryAccountId,
    '2026-05-06',
    'Transfer',
    -1000,
    'CAD',
    { txnType: 'transfer' },
  );
  await attachReceipt(t1);
  await attachReceipt(t3);
  // Two receipts on the same txn should still count as ONE txn-with-receipt.
  await attachReceipt(t1, 'duplicate.jpg');
  void t2;

  const res = await primaryAgent.get('/api/receipts/completeness?filter=all&currency=CAD');
  assert.equal(res.status, 200);
  assert.equal(res.body.filter, 'all');
  assert.equal(res.body.currency, 'CAD');
  assert.equal(res.body.totalCount, 4);
  assert.equal(res.body.withReceiptCount, 2);
  assert.equal(res.body.missingCount, 2);
  assert.equal(Number(res.body.totalAmount), 650);
  assert.equal(Number(res.body.withReceiptAmount), 400);
  assert.equal(Number(res.body.missingAmount), 250);
  assert.equal(Math.round(res.body.coverageByCount * 100) / 100, 0.5);
  assert.equal(Math.round((res.body.coverageByAmount as number) * 1000) / 1000, 0.615);
});

test('GET /api/receipts/completeness?filter=business only counts finalBusiness=true', async () => {
  // Seed a 3rd business txn (no receipt) and one business with a receipt.
  const b1 = await createTransaction(
    primaryHouseholdId,
    primaryAccountId,
    '2026-05-07',
    'Office',
    -400,
    'CAD',
    { finalBusiness: true },
  );
  await createTransaction(
    primaryHouseholdId,
    primaryAccountId,
    '2026-05-08',
    'Office',
    -100,
    'CAD',
    { finalBusiness: true },
  );
  await attachReceipt(b1);

  const res = await primaryAgent.get('/api/receipts/completeness?filter=business&currency=CAD');
  assert.equal(res.status, 200);
  assert.equal(res.body.filter, 'business');
  assert.equal(res.body.totalCount, 2);
  assert.equal(res.body.withReceiptCount, 1);
  assert.equal(res.body.missingCount, 1);
  assert.equal(Number(res.body.totalAmount), 500);
  assert.equal(Number(res.body.withReceiptAmount), 400);
  assert.equal(Number(res.body.missingAmount), 100);
  assert.equal(res.body.coverageByCount, 0.5);
  assert.equal(res.body.coverageByAmount, 0.8);
});

test('GET /api/receipts/completeness?filter=tax-relevant counts business + deductible-category rows', async () => {
  // Seed one deductible TaxCategory so we can test the tax-relevant category match.
  const models = await import('../../src/models');
  await models.TaxCategory.upsert({
    code: 'PROFESSIONAL_FEES',
    label: 'Professional Fees',
    isDeductible: true,
    t1Line: null,
    t2Schedule: null,
    t2Line: null,
    businessUseDefault: null,
  });
  // Non-business but deductible-category txn — should appear under tax-relevant.
  const t = await createTransaction(
    primaryHouseholdId,
    primaryAccountId,
    '2026-05-09',
    'Professional Fees',
    -250,
    'CAD',
    { finalBusiness: false, finalCategory: 'Professional Fees' },
  );
  await attachReceipt(t);

  const res = await primaryAgent.get(
    '/api/receipts/completeness?filter=tax-relevant&currency=CAD',
  );
  assert.equal(res.status, 200);
  assert.equal(res.body.filter, 'tax-relevant');
  // Tax-relevant = business (2 txns, 500) + deductible Professional Fees (1 txn, 250).
  assert.equal(res.body.totalCount, 3);
  assert.equal(res.body.withReceiptCount, 2);
  assert.equal(res.body.missingCount, 1);
  assert.equal(Number(res.body.totalAmount), 750);
  // withReceipt = the b1 from previous test (400) + this t (250) = 650.
  assert.equal(Number(res.body.withReceiptAmount), 650);
  assert.equal(Number(res.body.missingAmount), 100);
});

test('GET /api/receipts/completeness rejects unknown filter', async () => {
  const res = await primaryAgent.get('/api/receipts/completeness?filter=zebra');
  assert.equal(res.status, 400);
  assert.match(String(res.body.error), /filter/);
});

test('GET /api/receipts/missing returns spend txns without receipts, sorted by abs amount desc', async () => {
  const res = await primaryAgent.get('/api/receipts/missing?filter=all&currency=CAD');
  assert.equal(res.status, 200);
  const items = res.body.items as Array<{
    id: number;
    date: string;
    amount: number;
    currency: string;
    merchant: string;
    category: string | null;
    finalBusiness: boolean;
  }>;
  assert.ok(items.length >= 3, 'expect at least 3 missing-receipt rows');
  // Largest abs amount first. From the data so far: -200 Groceries, -100 Office (business),
  // -50 Coffee are the unreceipted spend rows (the -300 Travel + -100 Groceries + -400 Office
  // already have receipts). Order should be 200 > 100 > 50.
  const absDescending = items.every(
    (row, idx) => idx === 0 || Math.abs(items[idx - 1].amount) >= Math.abs(row.amount),
  );
  assert.ok(absDescending, 'rows must be sorted by absolute amount descending');
  // All returned rows have negative amounts (spend) and currency=CAD.
  for (const row of items) {
    assert.ok(row.amount < 0, 'missing receipt rows must be spend (negative amounts)');
    assert.equal(row.currency, 'CAD');
  }
});

test('GET /api/receipts/missing?filter=business only returns business spend without receipts', async () => {
  const res = await primaryAgent.get('/api/receipts/missing?filter=business&currency=CAD');
  assert.equal(res.status, 200);
  const items = res.body.items as Array<{ finalBusiness: boolean }>;
  assert.ok(items.length >= 1);
  for (const row of items) {
    assert.equal(row.finalBusiness, true);
  }
});

test('GET /api/receipts/missing supports limit', async () => {
  const res = await primaryAgent.get('/api/receipts/missing?filter=all&currency=CAD&limit=2');
  assert.equal(res.status, 200);
  const items = res.body.items as unknown[];
  assert.ok(items.length <= 2);
});

test('completeness/missing do not leak other households', async () => {
  // Seed a giant unreceipted spend for the OTHER household.
  await createTransaction(otherHouseholdId, otherAccountId, '2026-05-10', 'Other', -99999);

  // Primary should never see it.
  const completeness = await primaryAgent.get(
    '/api/receipts/completeness?filter=all&currency=CAD',
  );
  assert.notEqual(Number(completeness.body.totalAmount), 99999 + 650 + 500 + 250);

  const missing = await primaryAgent.get('/api/receipts/missing?filter=all&currency=CAD');
  const items = missing.body.items as Array<{ amount: number }>;
  for (const row of items) {
    assert.notEqual(Math.abs(row.amount), 99999);
  }

  // The other household sees their own row.
  const otherMissing = await otherAgent.get('/api/receipts/missing?filter=all&currency=CAD');
  const otherItems = otherMissing.body.items as Array<{ amount: number }>;
  assert.ok(otherItems.some((row) => Math.abs(row.amount) === 99999));
});

test('GET /api/receipts/completeness omits currency when no currency filter is supplied', async () => {
  // Seed a USD row so the cross-currency case has data.
  await createTransaction(
    primaryHouseholdId,
    primaryAccountId,
    '2026-05-11',
    'USD-Spend',
    -75,
    'USD',
  );
  const res = await primaryAgent.get('/api/receipts/completeness?filter=all');
  assert.equal(res.status, 200);
  // No currency filter → response includes a per-currency breakdown.
  assert.equal(res.body.currency, null);
  const byCurrency = res.body.byCurrency as Array<{
    currency: string;
    totalCount: number;
    withReceiptCount: number;
    totalAmount: number;
    withReceiptAmount: number;
  }>;
  assert.ok(Array.isArray(byCurrency));
  const cad = byCurrency.find((r) => r.currency === 'CAD');
  const usd = byCurrency.find((r) => r.currency === 'USD');
  assert.ok(cad, 'CAD breakdown present');
  assert.ok(usd, 'USD breakdown present');
  assert.equal(usd!.totalCount, 1);
  assert.equal(usd!.withReceiptCount, 0);
});
