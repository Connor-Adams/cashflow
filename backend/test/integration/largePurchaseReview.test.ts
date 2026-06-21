/**
 * Integration tests for the largePurchaseReview route surface (issue #244).
 * Exercises:
 *   PATCH /api/transactions/:id/large-purchase-review
 *   GET   /api/large-purchases/inbox
 *   GET   /api/large-purchases/all
 *   PATCH /api/settings/cashflow (largePurchaseThreshold)
 *
 * end-to-end against a real Postgres database. Seeding pattern mirrors
 * returnWarranty.test.ts.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import request from 'supertest';
import { testAgent } from './_setup/testServer.js';
import { setupPgTestDb, teardownPgTestDb, type PgTestDb } from './_setup/pgTestDb.js';

let app: import('express').Express;
let primaryAgent: ReturnType<typeof request.agent>;
let primaryHouseholdId: number;
let primaryAccountId: number;
let primaryUserId: number;
let otherAgent: ReturnType<typeof request.agent>;
let otherHouseholdId: number;
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
  amount: number,
): Promise<number> {
  const models = await import('../../src/models');
  const created = await models.Transaction.create({
    accountId,
    householdId,
    visibility: 'shared',
    ownershipType: 'me',
    ownershipContactId: null,
    importBatch: 'lp-test',
    date,
    merchantRaw: 'Test Merchant',
    merchantClean: 'Test Merchant',
    amount: amount.toFixed(4),
    currency: 'CAD',
    notes: null,
    sourceReference: null,
    sourceRowFingerprint: crypto.randomBytes(16).toString('hex'),
    sourceIdentityFingerprint: crypto.randomBytes(16).toString('hex'),
    appliedRuleId: null,
    autoCategory: null,
    categoryOverride: null,
    finalCategory: 'Electronics',
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
    reviewFlag: false,
    reviewedAt: null,
    createdByUserId: null,
  });
  return created.id;
}

before(async () => {
  // CRITICAL: NODE_ENV='test' so the aiSuggestLimiter skip() short-circuits.
  // The purchases and reimbursements routers (mounted at the bare '/api' prefix,
  // BEFORE largePurchaseReviewRouter) each call router.use(aiSuggestLimiter),
  // so that 60s/20-request limiter runs on EVERY /api/* request that passes
  // through them — including /api/large-purchases/* and the PATCH review route.
  // This file fires >20 sequential requests from the same client, which would
  // otherwise 429 every assertion past the first handful (mirrors the
  // reimbursements/statements/cfoBriefings integration tests).
  process.env.NODE_ENV = 'test';

  testDb = await setupPgTestDb('lp-review');
  const mod = await import('../../src/app.js');
  app = mod.default;

  const bootstrap = testAgent(app);
  const register = await bootstrap.post('/api/auth/register').send({
    email: 'superadmin@example.com',
    displayName: 'Super Admin',
    password: 'password123',
  });
  assert.equal(register.status, 201);

  const primary = await seed('Primary');
  primaryHouseholdId = primary.householdId;
  primaryAccountId = primary.accountId;
  primaryUserId = primary.userId;
  primaryAgent = testAgent(app);
  primaryAgent.jar.setCookie(`cashflow_session=${primary.token}; Path=/`);

  const other = await seed('Other');
  otherHouseholdId = other.householdId;
  otherAccountId = other.accountId;
  otherAgent = testAgent(app);
  otherAgent.jar.setCookie(`cashflow_session=${other.token}; Path=/`);
});

after(async () => {
  await teardownPgTestDb(testDb);
});

// ---- PATCH /api/transactions/:id/large-purchase-review -----------------------

test('PATCH creates review record with full checklist', async () => {
  const txnId = await createTransaction(
    primaryHouseholdId,
    primaryAccountId,
    '2026-06-01',
    -1299,
  );
  const res = await primaryAgent
    .patch(`/api/transactions/${txnId}/large-purchase-review`)
    .send({
      status: 'reviewed',
      categoryConfirmed: true,
      businessRelevant: false,
      receiptConfirmed: true,
      warrantyTracked: true,
      reimbursementTracked: false,
      notes: 'MacBook Pro',
      reviewedAt: '2026-06-01',
    });
  assert.equal(res.status, 200);
  assert.equal(res.body.data.transactionId, txnId);
  assert.equal(res.body.data.status, 'reviewed');
  assert.equal(res.body.data.categoryConfirmed, true);
  assert.equal(res.body.data.businessRelevant, false);
  assert.equal(res.body.data.receiptConfirmed, true);
  assert.equal(res.body.data.warrantyTracked, true);
  assert.equal(res.body.data.reimbursementTracked, false);
  assert.equal(res.body.data.notes, 'MacBook Pro');
  assert.equal(res.body.data.reviewedAt, '2026-06-01');
});

test('PATCH updates existing review record idempotently', async () => {
  const txnId = await createTransaction(
    primaryHouseholdId,
    primaryAccountId,
    '2026-06-02',
    -1500,
  );
  await primaryAgent
    .patch(`/api/transactions/${txnId}/large-purchase-review`)
    .send({ status: 'pending', notes: 'Initial' });
  const res = await primaryAgent
    .patch(`/api/transactions/${txnId}/large-purchase-review`)
    .send({ status: 'dismissed', notes: 'Changed mind' });
  assert.equal(res.status, 200);
  assert.equal(res.body.data.status, 'dismissed');
  assert.equal(res.body.data.notes, 'Changed mind');
});

test('PATCH rejects invalid status', async () => {
  const txnId = await createTransaction(
    primaryHouseholdId,
    primaryAccountId,
    '2026-06-03',
    -600,
  );
  const res = await primaryAgent
    .patch(`/api/transactions/${txnId}/large-purchase-review`)
    .send({ status: 'approved' });
  assert.equal(res.status, 400);
});

test('PATCH rejects malformed reviewedAt', async () => {
  const txnId = await createTransaction(
    primaryHouseholdId,
    primaryAccountId,
    '2026-06-04',
    -600,
  );
  const res = await primaryAgent
    .patch(`/api/transactions/${txnId}/large-purchase-review`)
    .send({ reviewedAt: '2026/06/04' });
  assert.equal(res.status, 400);
});

test('PATCH 404 for a transaction in a different household', async () => {
  const otherTxnId = await createTransaction(
    otherHouseholdId,
    otherAccountId,
    '2026-06-05',
    -800,
  );
  const res = await primaryAgent
    .patch(`/api/transactions/${otherTxnId}/large-purchase-review`)
    .send({ status: 'reviewed' });
  assert.equal(res.status, 404);
});

// ---- GET /api/large-purchases/inbox ------------------------------------------

test('GET /inbox returns purchases at or above the threshold (default 500)', async () => {
  const aboveThreshold = await createTransaction(
    primaryHouseholdId,
    primaryAccountId,
    '2026-06-10',
    -750,
  );
  const atThreshold = await createTransaction(
    primaryHouseholdId,
    primaryAccountId,
    '2026-06-10',
    -500,
  );
  const belowThreshold = await createTransaction(
    primaryHouseholdId,
    primaryAccountId,
    '2026-06-10',
    -499,
  );

  const res = await primaryAgent.get('/api/large-purchases/inbox');
  assert.equal(res.status, 200);
  const ids = (res.body.data as { id: number }[]).map((r) => r.id);
  assert.ok(ids.includes(aboveThreshold), 'above threshold should appear in inbox');
  assert.ok(ids.includes(atThreshold), 'at threshold should appear in inbox');
  assert.ok(!ids.includes(belowThreshold), 'below threshold should NOT appear');
});

test('GET /inbox excludes reviewed and dismissed purchases', async () => {
  const pending = await createTransaction(
    primaryHouseholdId,
    primaryAccountId,
    '2026-06-11',
    -700,
  );
  const reviewed = await createTransaction(
    primaryHouseholdId,
    primaryAccountId,
    '2026-06-11',
    -900,
  );
  const dismissed = await createTransaction(
    primaryHouseholdId,
    primaryAccountId,
    '2026-06-11',
    -1100,
  );

  await primaryAgent
    .patch(`/api/transactions/${reviewed}/large-purchase-review`)
    .send({ status: 'reviewed' });
  await primaryAgent
    .patch(`/api/transactions/${dismissed}/large-purchase-review`)
    .send({ status: 'dismissed' });

  const res = await primaryAgent.get('/api/large-purchases/inbox');
  assert.equal(res.status, 200);
  const ids = (res.body.data as { id: number }[]).map((r) => r.id);
  assert.ok(ids.includes(pending), 'pending should appear in inbox');
  assert.ok(!ids.includes(reviewed), 'reviewed should NOT appear in inbox');
  assert.ok(!ids.includes(dismissed), 'dismissed should NOT appear in inbox');
});

test('GET /inbox respects threshold change via settings PATCH', async () => {
  const midRange = await createTransaction(
    primaryHouseholdId,
    primaryAccountId,
    '2026-06-12',
    -300,
  );

  // Default threshold is 500 — midRange (-300) should NOT appear.
  const resBefore = await primaryAgent.get('/api/large-purchases/inbox');
  const idsBefore = (resBefore.body.data as { id: number }[]).map((r) => r.id);
  assert.ok(!idsBefore.includes(midRange), 'should not appear with default threshold');

  // Lower threshold to 200 — now midRange should appear.
  const settingsPatch = await primaryAgent
    .patch('/api/settings/cashflow')
    .send({ largePurchaseThreshold: 200 });
  assert.equal(settingsPatch.status, 200);
  assert.equal(settingsPatch.body.largePurchaseThreshold, '200.0000');

  const resAfter = await primaryAgent.get('/api/large-purchases/inbox');
  const idsAfter = (resAfter.body.data as { id: number }[]).map((r) => r.id);
  assert.ok(idsAfter.includes(midRange), 'should appear after threshold lowered to 200');

  // Reset threshold.
  await primaryAgent.patch('/api/settings/cashflow').send({ largePurchaseThreshold: 500 });
});

// ---- GET /api/large-purchases/all -------------------------------------------

test('GET /all includes reviewed and dismissed (not just pending)', async () => {
  const pendingTxn = await createTransaction(
    primaryHouseholdId,
    primaryAccountId,
    '2026-06-15',
    -600,
  );
  const reviewedTxn = await createTransaction(
    primaryHouseholdId,
    primaryAccountId,
    '2026-06-15',
    -850,
  );
  const dismissedTxn = await createTransaction(
    primaryHouseholdId,
    primaryAccountId,
    '2026-06-15',
    -950,
  );

  await primaryAgent
    .patch(`/api/transactions/${reviewedTxn}/large-purchase-review`)
    .send({ status: 'reviewed' });
  await primaryAgent
    .patch(`/api/transactions/${dismissedTxn}/large-purchase-review`)
    .send({ status: 'dismissed' });

  const res = await primaryAgent.get('/api/large-purchases/all');
  assert.equal(res.status, 200);
  const ids = (res.body.data as { id: number }[]).map((r) => r.id);
  assert.ok(ids.includes(pendingTxn), 'pending should appear in all');
  assert.ok(ids.includes(reviewedTxn), 'reviewed should appear in all');
  assert.ok(ids.includes(dismissedTxn), 'dismissed should appear in all');
});

// ---- Cross-household isolation -----------------------------------------------

test('GET endpoints scope to the requesting household', async () => {
  const otherTxn = await createTransaction(
    otherHouseholdId,
    otherAccountId,
    '2026-06-20',
    -1200,
  );

  const primaryRes = await primaryAgent.get('/api/large-purchases/inbox');
  const ids = (primaryRes.body.data as { id: number }[]).map((r) => r.id);
  assert.ok(!ids.includes(otherTxn), 'other household txn should not appear');
});

// ---- Settings validation ------------------------------------------------------

test('PATCH /settings/cashflow rejects negative largePurchaseThreshold', async () => {
  const res = await primaryAgent
    .patch('/api/settings/cashflow')
    .send({ largePurchaseThreshold: -1 });
  assert.equal(res.status, 400);
  assert.ok(res.body.error.includes('largePurchaseThreshold'));
});

test('PATCH /settings/cashflow rejects threshold above 1_000_000', async () => {
  const res = await primaryAgent
    .patch('/api/settings/cashflow')
    .send({ largePurchaseThreshold: 1_000_001 });
  assert.equal(res.status, 400);
});

test('PATCH /settings/cashflow accepts 0 (disables flagging)', async () => {
  const res = await primaryAgent
    .patch('/api/settings/cashflow')
    .send({ largePurchaseThreshold: 0 });
  assert.equal(res.status, 200);
  assert.equal(res.body.largePurchaseThreshold, '0.0000');
  // Restore default.
  await primaryAgent.patch('/api/settings/cashflow').send({ largePurchaseThreshold: 500 });
});

test('GET /settings/cashflow returns largePurchaseThreshold', async () => {
  const res = await primaryAgent.get('/api/settings/cashflow');
  assert.equal(res.status, 200);
  assert.ok('largePurchaseThreshold' in res.body, 'largePurchaseThreshold should be present');
});
