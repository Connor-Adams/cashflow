/**
 * Integration tests for the businessTax route surface — exercises
 * /api/tax-tags, /api/business/tax-summary, /api/business/missing-receipts,
 * /api/business/review-queue, /api/transactions/:id/tax, and /api/exports/tax
 * end-to-end against a real Postgres database. Mirrors the same seeding
 * shape as budgets.test.ts.
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

async function createTransaction(
  householdId: number,
  accountId: number,
  date: string,
  category: string | null,
  amount: number,
  options: { business?: boolean; split?: string; currency?: string } = {},
): Promise<number> {
  const models = await import('../../src/models');
  const created = await models.Transaction.create({
    accountId,
    householdId,
    visibility: 'shared',
    ownershipType: 'me',
    ownershipContactId: null,
    importBatch: 'biztax-test',
    date,
    merchantRaw: 'Test Merchant',
    merchantClean: 'Test Merchant',
    amount: amount.toFixed(4),
    currency: options.currency ?? 'CAD',
    notes: null,
    sourceReference: null,
    sourceRowFingerprint: crypto.randomBytes(16).toString('hex'),
    sourceIdentityFingerprint: crypto.randomBytes(16).toString('hex'),
    appliedRuleId: null,
    autoCategory: null,
    categoryOverride: null,
    finalCategory: category,
    autoBusiness: null,
    businessOverride: options.business ?? null,
    finalBusiness: options.business ?? false,
    autoSplitType: null,
    splitOverride: null,
    finalSplitType: options.split ?? 'me',
    autoPctMe: null,
    pctMeOverride: null,
    finalPctMe: null,
    autoPctPartner: null,
    pctPartnerOverride: null,
    finalPctPartner: null,
    reviewFlag: false,
    reviewedAt: null,
    createdByUserId: null,
  });
  return created.id;
}

before(async () => {
  testDb = await setupPgTestDb('biztax');
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

// ---- tax-tags -----------------------------------------------------------

test('POST /api/tax-tags creates a tag for the household', async () => {
  const res = await primaryAgent.post('/api/tax-tags').send({
    name: 'Office',
    description: 'Office expenses',
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.data.name, 'Office');
});

test('POST /api/tax-tags rejects duplicate name within same household', async () => {
  const res = await primaryAgent.post('/api/tax-tags').send({ name: 'Office' });
  assert.equal(res.status, 409);
});

test('POST /api/tax-tags rejects empty name', async () => {
  const res = await primaryAgent.post('/api/tax-tags').send({ name: '   ' });
  assert.equal(res.status, 400);
});

test('GET /api/tax-tags returns only the requesting household tags', async () => {
  await otherAgent.post('/api/tax-tags').send({ name: 'Office' });
  const primaryList = await primaryAgent.get('/api/tax-tags');
  const otherList = await otherAgent.get('/api/tax-tags');
  assert.equal(primaryList.status, 200);
  assert.equal(otherList.status, 200);
  assert.equal(primaryList.body.data.length, 1);
  assert.equal(otherList.body.data.length, 1);
  // Even though both households reused "Office", the IDs differ.
  assert.notEqual(primaryList.body.data[0].id, otherList.body.data[0].id);
});

// ---- PATCH /api/transactions/:id/tax ------------------------------------

test('PATCH /api/transactions/:id/tax sets metadata for an existing transaction', async () => {
  const txnId = await createTransaction(
    primaryHouseholdId,
    primaryAccountId,
    '2026-03-01',
    'Office',
    -113,
    { business: true },
  );

  const tagsRes = await primaryAgent.get('/api/tax-tags');
  const officeTagId = tagsRes.body.data[0].id as number;

  const res = await primaryAgent
    .patch(`/api/transactions/${txnId}/tax`)
    .send({
      taxTagId: officeTagId,
      deductiblePercent: 0.5,
      hstGstAmount: 13,
      receiptRequired: true,
      reviewedForTax: true,
    });
  assert.equal(res.status, 200);
  assert.equal(res.body.data.taxTagId, officeTagId);
  assert.equal(Number(res.body.data.deductiblePercent), 0.5);
  assert.equal(Number(res.body.data.hstGstAmount), 13);
  assert.equal(res.body.data.receiptRequired, true);
  assert.equal(res.body.data.reviewedForTax, true);
});

test('PATCH /api/transactions/:id/tax rejects deductible > 1', async () => {
  const txnId = await createTransaction(
    primaryHouseholdId,
    primaryAccountId,
    '2026-03-02',
    'Office',
    -50,
    { business: true },
  );
  const res = await primaryAgent
    .patch(`/api/transactions/${txnId}/tax`)
    .send({ deductiblePercent: 1.5 });
  assert.equal(res.status, 400);
});

test('PATCH /api/transactions/:id/tax 404 when transaction is in another household', async () => {
  const otherTxnId = await createTransaction(
    otherHouseholdId,
    otherAccountId,
    '2026-03-03',
    'Office',
    -100,
    { business: true },
  );
  const res = await primaryAgent
    .patch(`/api/transactions/${otherTxnId}/tax`)
    .send({ reviewedForTax: true });
  assert.equal(res.status, 404);
});

test('PATCH /api/transactions/:id/tax rejects taxTagId from another household', async () => {
  // Create a tag in the OTHER household and try to attach it from primary.
  const tagsRes = await otherAgent.get('/api/tax-tags');
  const otherTagId = tagsRes.body.data[0].id as number;

  const txnId = await createTransaction(
    primaryHouseholdId,
    primaryAccountId,
    '2026-03-04',
    'Office',
    -100,
    { business: true },
  );
  const res = await primaryAgent
    .patch(`/api/transactions/${txnId}/tax`)
    .send({ taxTagId: otherTagId });
  assert.equal(res.status, 400);
});

// ---- /api/business/tax-summary -----------------------------------------

test('GET /api/business/tax-summary aggregates by currency for the scope', async () => {
  // Three business CAD charges in the period; one personal that must be skipped.
  await createTransaction(primaryHouseholdId, primaryAccountId, '2026-04-01', 'Office', -100, { business: true });
  await createTransaction(primaryHouseholdId, primaryAccountId, '2026-04-02', 'Office', -200, { business: true });
  await createTransaction(primaryHouseholdId, primaryAccountId, '2026-04-03', 'Groceries', -50);

  const res = await primaryAgent.get(
    '/api/business/tax-summary?scope=business&from=2026-04-01&to=2026-04-30',
  );
  assert.equal(res.status, 200);
  assert.equal(res.body.scope, 'business');
  const cad = res.body.data.find((r: { currency: string }) => r.currency === 'CAD');
  assert.ok(cad);
  // Only the two business txns count: 100 + 200 = 300 gross, 100% deductible by default.
  assert.equal(Number(cad.gross), 300);
  assert.equal(Number(cad.deductibleEstimate), 300);
  assert.equal(cad.transactionCount, 2);
});

test('GET /api/business/tax-summary respects personal scope', async () => {
  const res = await primaryAgent.get(
    '/api/business/tax-summary?scope=personal&from=2026-04-01&to=2026-04-30',
  );
  assert.equal(res.status, 200);
  const cad = res.body.data.find((r: { currency: string }) => r.currency === 'CAD');
  assert.ok(cad);
  // Only the personal $50 row counts.
  assert.equal(Number(cad.gross), 50);
  // Personal default deductible is 0%, so no estimate.
  assert.equal(Number(cad.deductibleEstimate), 0);
});

// ---- /api/business/missing-receipts ------------------------------------

test('GET /api/business/missing-receipts lists business txns without a receipt', async () => {
  // Two business charges in May; one will get a receipt attached, the other won't.
  const withReceiptId = await createTransaction(
    primaryHouseholdId,
    primaryAccountId,
    '2026-05-01',
    'Office',
    -75,
    { business: true },
  );
  await createTransaction(
    primaryHouseholdId,
    primaryAccountId,
    '2026-05-02',
    'Office',
    -25,
    { business: true },
  );
  const models = await import('../../src/models');
  await models.Receipt.create({
    transactionId: withReceiptId,
    storedFilename: 'r.pdf',
    originalName: 'r.pdf',
    mimeType: 'application/pdf',
    sizeBytes: 100,
  });

  const res = await primaryAgent.get(
    '/api/business/missing-receipts?scope=business&from=2026-05-01&to=2026-05-31',
  );
  assert.equal(res.status, 200);
  assert.equal(res.body.count, 1);
  assert.equal(res.body.data[0].amount.startsWith('-25'), true);
});

// ---- /api/business/review-queue ----------------------------------------

test('GET /api/business/review-queue excludes reviewed transactions', async () => {
  const txnId = await createTransaction(
    primaryHouseholdId,
    primaryAccountId,
    '2026-06-01',
    'Office',
    -33,
    { business: true },
  );
  const before = await primaryAgent.get(
    '/api/business/review-queue?scope=business&from=2026-06-01&to=2026-06-30',
  );
  assert.equal(before.status, 200);
  const beforeIds = (before.body.data as { id: number }[]).map((r) => r.id);
  assert.ok(beforeIds.includes(txnId), 'unreviewed business txn should appear');

  await primaryAgent
    .patch(`/api/transactions/${txnId}/tax`)
    .send({ reviewedForTax: true });

  const after = await primaryAgent.get(
    '/api/business/review-queue?scope=business&from=2026-06-01&to=2026-06-30',
  );
  const afterIds = (after.body.data as { id: number }[]).map((r) => r.id);
  assert.ok(!afterIds.includes(txnId), 'reviewed txn should disappear');
});

// ---- /api/exports/tax --------------------------------------------------

test('GET /api/exports/tax returns CSV with content-disposition', async () => {
  const res = await primaryAgent.get(
    '/api/exports/tax?scope=business&from=2026-04-01&to=2026-04-30',
  );
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /text\/csv/);
  assert.match(res.headers['content-disposition'], /attachment;.*tax-business-/);
  const body = res.text;
  // Header line present.
  assert.match(
    body,
    /id,date,merchant,account,currency,amount,category,business,split,tax_tag,deductible_percent,deductible_amount,hst_gst_amount,receipt_required,has_receipt,reviewed_for_tax,notes/,
  );
  // At least one business row from the seed window appears (we created two in April).
  assert.ok(body.split('\n').length >= 2);
});
