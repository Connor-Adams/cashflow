/**
 * Integration tests for /api/budgets. Run in isolation
 * (`yarn test:integration`) so DATABASE_URL is set before any Sequelize
 * import.
 *
 * Mirrors `settlements.test.ts`: bootstrap a superadmin, then seed two
 * non-superadmin households so cross-household isolation can be exercised
 * via real session cookies.
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
    importBatch: 'budgets-test',
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
    finalCategory: category,
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
  });
  return row.id;
}

before(async () => {
  testDb = await setupPgTestDb('budgets');

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

test('POST /api/budgets creates a category budget', async () => {
  const res = await primaryAgent.post('/api/budgets').send({
    category: 'Groceries',
    currency: 'CAD',
    amount: 400,
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.category, 'Groceries');
  assert.equal(res.body.currency, 'CAD');
  assert.equal(Number(res.body.amount), 400);
  assert.equal(res.body.period, 'monthly');
});

test('POST /api/budgets with null category creates an overall budget', async () => {
  const res = await primaryAgent.post('/api/budgets').send({
    category: null,
    currency: 'CAD',
    amount: 3000,
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.category, null);
});

test('POST /api/budgets rejects amount <= 0', async () => {
  const res = await primaryAgent.post('/api/budgets').send({
    category: 'Coffee',
    currency: 'CAD',
    amount: 0,
  });
  assert.equal(res.status, 400);
});

test('PUT /api/budgets/:id updates an existing budget', async () => {
  const created = await primaryAgent.post('/api/budgets').send({
    category: 'Travel',
    currency: 'CAD',
    amount: 200,
  });
  assert.equal(created.status, 201);
  const id = created.body.id as number;

  const updated = await primaryAgent
    .put(`/api/budgets/${id}`)
    .send({ amount: 350 });
  assert.equal(updated.status, 200);
  assert.equal(Number(updated.body.amount), 350);
  assert.equal(updated.body.category, 'Travel');
});

test('GET /api/budgets/progress sums spend within the calendar month', async () => {
  // Seed two charges in the current month (negative amounts = spend) plus a
  // refund (positive amount) that must NOT lower spend.
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  await createTransaction(primaryHouseholdId, primaryAccountId, `${y}-${m}-05`, 'Groceries', -120);
  await createTransaction(primaryHouseholdId, primaryAccountId, `${y}-${m}-15`, 'Groceries', -30);
  await createTransaction(primaryHouseholdId, primaryAccountId, `${y}-${m}-16`, 'Groceries', 25);

  const res = await primaryAgent.get('/api/budgets/progress');
  assert.equal(res.status, 200);
  const items = res.body.items as Array<{
    category: string | null;
    currency: string;
    spent: number;
    target: number;
    percentUsed: number;
  }>;
  const groceries = items.find((i) => i.category === 'Groceries' && i.currency === 'CAD');
  assert.ok(groceries, 'should include a Groceries CAD row');
  assert.equal(groceries!.spent, 150);
  assert.equal(groceries!.target, 400);
  assert.equal(groceries!.percentUsed, (150 / 400) * 100);
});

test('GET /api/budgets/progress: overall budget sums spend across all categories', async () => {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  // Add a separate-category charge in the same month.
  await createTransaction(primaryHouseholdId, primaryAccountId, `${y}-${m}-08`, 'Rent', -1800);

  const res = await primaryAgent.get('/api/budgets/progress');
  assert.equal(res.status, 200);
  const items = res.body.items as Array<{
    category: string | null;
    currency: string;
    spent: number;
    target: number;
  }>;
  const overall = items.find((i) => i.category === null && i.currency === 'CAD');
  assert.ok(overall, 'should include an overall CAD row');
  // Groceries (150) + Rent (1800) = 1950
  assert.equal(overall!.spent, 1950);
  assert.equal(overall!.target, 3000);
});

test('GET /api/budgets/progress: ignores transactions outside the current month', async () => {
  // Charges from a different year should not affect the current-month total.
  await createTransaction(
    primaryHouseholdId,
    primaryAccountId,
    '2024-01-15',
    'Groceries',
    -9999
  );
  const res = await primaryAgent.get('/api/budgets/progress');
  const items = res.body.items as Array<{ category: string | null; spent: number }>;
  const groceries = items.find((i) => i.category === 'Groceries');
  assert.ok(groceries);
  assert.equal(groceries!.spent, 150);
});

test('GET /api/budgets does not leak other households rows', async () => {
  const created = await otherAgent.post('/api/budgets').send({
    category: 'Groceries',
    currency: 'CAD',
    amount: 999,
  });
  assert.equal(created.status, 201);
  const otherBudgetId = created.body.id as number;
  void otherHouseholdId;
  void otherAccountId;

  const primaryList = await primaryAgent.get('/api/budgets');
  assert.equal(primaryList.status, 200);
  const ids = (primaryList.body.data as Array<{ id: number }>).map((b) => b.id);
  assert.ok(!ids.includes(otherBudgetId));
});

test('DELETE /api/budgets/:id only affects the owning household', async () => {
  const created = await primaryAgent.post('/api/budgets').send({
    category: 'Subscriptions',
    currency: 'USD',
    amount: 50,
  });
  assert.equal(created.status, 201);
  const id = created.body.id as number;

  const wrongHousehold = await otherAgent.delete(`/api/budgets/${id}`);
  assert.equal(wrongHousehold.status, 404);

  const owner = await primaryAgent.delete(`/api/budgets/${id}`);
  assert.equal(owner.status, 204);

  const gone = await primaryAgent.delete(`/api/budgets/${id}`);
  assert.equal(gone.status, 404);
});

// ---- Issue #201: scope, period, rollover, exclusions, status ----------

test('POST /api/budgets accepts scope and rolloverEnabled with new defaults', async () => {
  const res = await primaryAgent.post('/api/budgets').send({
    category: 'Coffee',
    currency: 'CAD',
    amount: 60,
    scope: 'personal',
    rolloverEnabled: true,
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.scope, 'personal');
  assert.equal(res.body.rolloverEnabled, true);
  // Without explicit period, monthly is preserved.
  assert.equal(res.body.period, 'monthly');
});

test('POST /api/budgets defaults scope to household and rollover to false', async () => {
  const res = await primaryAgent.post('/api/budgets').send({
    category: 'Streaming',
    currency: 'CAD',
    amount: 30,
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.scope, 'household');
  assert.equal(res.body.rolloverEnabled, false);
});

test('POST /api/budgets rejects unknown scope value', async () => {
  const res = await primaryAgent.post('/api/budgets').send({
    category: 'Travel',
    currency: 'CAD',
    amount: 200,
    scope: 'planet',
  });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /scope/);
});

test('POST /api/budgets accepts weekly and annual period values', async () => {
  const weekly = await primaryAgent.post('/api/budgets').send({
    category: 'Lunch',
    currency: 'CAD',
    amount: 80,
    period: 'weekly',
  });
  assert.equal(weekly.status, 201);
  assert.equal(weekly.body.period, 'weekly');

  const annual = await primaryAgent.post('/api/budgets').send({
    category: 'Insurance',
    currency: 'CAD',
    amount: 2400,
    period: 'annual',
  });
  assert.equal(annual.status, 201);
  assert.equal(annual.body.period, 'annual');
});

test('GET /api/budgets/status returns pacing fields', async () => {
  // The Groceries budget seeded earlier has CAD 150 spent / 400 target.
  // We assert the new pacing fields appear regardless of date drift.
  const res = await primaryAgent.get('/api/budgets/status');
  assert.equal(res.status, 200);
  const items = res.body.items as Array<{
    category: string | null;
    currency: string;
    spent: number;
    target: number;
    percentUsed: number;
    periodElapsedPercent: number;
    pacingState: string;
    scope: string;
    period: string;
    rolloverEnabled: boolean;
  }>;
  const groceries = items.find(
    (i) => i.category === 'Groceries' && i.currency === 'CAD' && i.period === 'monthly'
  );
  assert.ok(groceries, 'should include the monthly Groceries CAD row');
  assert.equal(groceries!.scope, 'household');
  // periodElapsedPercent is always 0..100
  assert.ok(groceries!.periodElapsedPercent >= 0);
  assert.ok(groceries!.periodElapsedPercent <= 100);
  // pacingState is one of the four known states
  assert.ok(
    ['on-pace', 'ahead', 'behind', 'over'].includes(groceries!.pacingState),
    `unexpected pacing state ${groceries!.pacingState}`
  );
  assert.equal(typeof groceries!.rolloverEnabled, 'boolean');
});

test('GET /api/budgets/status: personal scope filters out shared spend', async () => {
  // Create a personal-scope budget for a unique category, then seed:
  //   - One shared spend on that category (should NOT count for personal)
  //   - One private spend on that category (SHOULD count for personal)
  const created = await primaryAgent.post('/api/budgets').send({
    category: 'Personal-Scope-Test',
    currency: 'CAD',
    amount: 100,
    scope: 'personal',
  });
  assert.equal(created.status, 201);

  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  // Shared spend — should be ignored by a personal-scope budget.
  await createTransaction(
    primaryHouseholdId,
    primaryAccountId,
    `${y}-${m}-10`,
    'Personal-Scope-Test',
    -50,
    'CAD',
    { visibility: 'shared' }
  );
  // Private spend — should count.
  await createTransaction(
    primaryHouseholdId,
    primaryAccountId,
    `${y}-${m}-11`,
    'Personal-Scope-Test',
    -20,
    'CAD',
    { visibility: 'private' }
  );

  const res = await primaryAgent.get('/api/budgets/status');
  const items = res.body.items as Array<{
    category: string | null;
    scope: string;
    spent: number;
  }>;
  const personal = items.find(
    (i) => i.category === 'Personal-Scope-Test' && i.scope === 'personal'
  );
  assert.ok(personal, 'personal budget row should exist');
  // Only the 20 should count; 50 was shared.
  assert.equal(personal!.spent, 20);
});

test('GET /api/budgets/status: business scope only counts finalBusiness=true', async () => {
  const created = await primaryAgent.post('/api/budgets').send({
    category: 'Business-Scope-Test',
    currency: 'CAD',
    amount: 500,
    scope: 'business',
  });
  assert.equal(created.status, 201);

  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  // Non-business charge — should be ignored.
  await createTransaction(
    primaryHouseholdId,
    primaryAccountId,
    `${y}-${m}-12`,
    'Business-Scope-Test',
    -75,
    'CAD',
    { finalBusiness: false }
  );
  // Business charge — should count.
  await createTransaction(
    primaryHouseholdId,
    primaryAccountId,
    `${y}-${m}-13`,
    'Business-Scope-Test',
    -125,
    'CAD',
    { finalBusiness: true }
  );

  const res = await primaryAgent.get('/api/budgets/status');
  const items = res.body.items as Array<{
    category: string | null;
    scope: string;
    spent: number;
  }>;
  const biz = items.find(
    (i) => i.category === 'Business-Scope-Test' && i.scope === 'business'
  );
  assert.ok(biz);
  assert.equal(biz!.spent, 125);
});

test('budget exclusions are honored by /api/budgets/status', async () => {
  const created = await primaryAgent.post('/api/budgets').send({
    category: 'Exclusion-Test',
    currency: 'CAD',
    amount: 200,
    scope: 'household',
  });
  const budgetId = created.body.id as number;
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');

  // Two charges in-period that would normally both count.
  const goodTxnId = await createTransaction(
    primaryHouseholdId,
    primaryAccountId,
    `${y}-${m}-14`,
    'Exclusion-Test',
    -40
  );
  const excludedTxnId = await createTransaction(
    primaryHouseholdId,
    primaryAccountId,
    `${y}-${m}-15`,
    'Exclusion-Test',
    -160
  );

  // Baseline — both count.
  const before = await primaryAgent.get('/api/budgets/status');
  const beforeItem = (before.body.items as Array<{
    category: string | null;
    spent: number;
  }>).find((i) => i.category === 'Exclusion-Test');
  assert.equal(beforeItem!.spent, 200);

  // Exclude the larger one.
  const ex = await primaryAgent
    .post(`/api/budgets/${budgetId}/exclusions`)
    .send({ transactionId: excludedTxnId });
  assert.equal(ex.status, 201);
  assert.equal(ex.body.transactionId, excludedTxnId);

  // After — only the 40 charge counts.
  const after = await primaryAgent.get('/api/budgets/status');
  const afterItem = (after.body.items as Array<{
    category: string | null;
    spent: number;
  }>).find((i) => i.category === 'Exclusion-Test');
  assert.equal(afterItem!.spent, 40);

  // Idempotency: re-POSTing the same exclusion returns 200 with the
  // existing row, not 409 or a duplicate.
  const dup = await primaryAgent
    .post(`/api/budgets/${budgetId}/exclusions`)
    .send({ transactionId: excludedTxnId });
  assert.equal(dup.status, 200);
  assert.equal(dup.body.id, ex.body.id);

  // GET /exclusions lists what we created.
  const listed = await primaryAgent.get(`/api/budgets/${budgetId}/exclusions`);
  assert.equal(listed.status, 200);
  assert.ok(
    (listed.body.data as Array<{ transactionId: number }>).some(
      (row) => row.transactionId === excludedTxnId
    )
  );

  // DELETE exclusion restores the spend.
  const del = await primaryAgent.delete(
    `/api/budgets/${budgetId}/exclusions/${excludedTxnId}`
  );
  assert.equal(del.status, 204);
  const restored = await primaryAgent.get('/api/budgets/status');
  const restoredItem = (restored.body.items as Array<{
    category: string | null;
    spent: number;
  }>).find((i) => i.category === 'Exclusion-Test');
  assert.equal(restoredItem!.spent, 200);

  void goodTxnId;
});

test('POST /api/budgets/:id/exclusions rejects another household transaction', async () => {
  // Create a budget on primary, then try to exclude an other-household txn.
  const created = await primaryAgent.post('/api/budgets').send({
    category: 'Cross-Household-Test',
    currency: 'CAD',
    amount: 100,
  });
  const budgetId = created.body.id as number;

  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const foreignTxnId = await createTransaction(
    otherHouseholdId,
    otherAccountId,
    `${y}-${m}-09`,
    'Cross-Household-Test',
    -50
  );

  const res = await primaryAgent
    .post(`/api/budgets/${budgetId}/exclusions`)
    .send({ transactionId: foreignTxnId });
  assert.equal(res.status, 404);
});

// ---- Issue #215: excludeRefundedPurchases ----

async function createRefundLinkedTransaction(
  householdId: number,
  accountId: number,
  date: string,
  category: string | null,
  amount: number,
  linkedTransactionId: number,
  currency = 'CAD'
): Promise<number> {
  const models = await import('../../src/models');
  const row = await models.Transaction.create({
    accountId,
    householdId,
    visibility: 'shared',
    ownershipType: 'me',
    ownershipContactId: null,
    importBatch: 'budgets-test',
    date,
    merchantRaw: 'Refund Test',
    merchantClean: 'Refund Test',
    amount: amount.toFixed(4),
    currency,
    notes: null,
    sourceReference: null,
    sourceRowFingerprint: crypto.randomBytes(16).toString('hex'),
    sourceIdentityFingerprint: crypto.randomBytes(16).toString('hex'),
    appliedRuleId: null,
    autoCategory: null,
    categoryOverride: null,
    finalCategory: category,
    autoBusiness: null,
    businessOverride: null,
    finalBusiness: false,
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
    txnType: 'refund',
    linkedTransactionId,
  });
  return row.id;
}

test('excludeRefundedPurchases: subtracts linked original from budget spend when toggled on', async () => {
  // Fresh budget with the flag set. Use a unique category so prior tests
  // sharing the primary household don't bleed in.
  const created = await primaryAgent.post('/api/budgets').send({
    category: 'RefundExclude-Test',
    currency: 'CAD',
    amount: 500,
    excludeRefundedPurchases: true,
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.excludeRefundedPurchases, true);
  const budgetId = created.body.id as number;

  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');

  // $200 purchase that will be refunded.
  const refundedOriginalId = await createTransaction(
    primaryHouseholdId,
    primaryAccountId,
    `${y}-${m}-05`,
    'RefundExclude-Test',
    -200
  );
  // $80 purchase that stays as spend.
  await createTransaction(
    primaryHouseholdId,
    primaryAccountId,
    `${y}-${m}-06`,
    'RefundExclude-Test',
    -80
  );
  // The refund — points back at the $200 row via linked_transaction_id.
  await createRefundLinkedTransaction(
    primaryHouseholdId,
    primaryAccountId,
    `${y}-${m}-10`,
    'RefundExclude-Test',
    200,
    refundedOriginalId
  );

  const res = await primaryAgent.get('/api/budgets/progress');
  assert.equal(res.status, 200);
  const items = res.body.items as Array<{
    budgetId: number;
    category: string | null;
    spent: number;
    excludeRefundedPurchases?: boolean;
  }>;
  const row = items.find((i) => i.budgetId === budgetId);
  assert.ok(row, 'budget should appear in /progress');
  // 80 not 280: the $200 charge that got refunded must not count.
  assert.equal(row!.spent, 80);
  assert.equal(row!.excludeRefundedPurchases, true);
});

test('excludeRefundedPurchases: a PARTIAL refund nets only the refunded amount', async () => {
  const created = await primaryAgent.post('/api/budgets').send({
    category: 'PartialRefund-Test',
    currency: 'CAD',
    amount: 500,
    excludeRefundedPurchases: true,
  });
  assert.equal(created.status, 201);
  const budgetId = created.body.id as number;

  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');

  // $200 purchase, only $50 of it refunded → $150 should still count.
  const refundedOriginalId = await createTransaction(
    primaryHouseholdId,
    primaryAccountId,
    `${y}-${m}-05`,
    'PartialRefund-Test',
    -200
  );
  await createRefundLinkedTransaction(
    primaryHouseholdId,
    primaryAccountId,
    `${y}-${m}-10`,
    'PartialRefund-Test',
    50,
    refundedOriginalId
  );

  const res = await primaryAgent.get('/api/budgets/progress');
  assert.equal(res.status, 200);
  const items = res.body.items as Array<{ budgetId: number; spent: number }>;
  const row = items.find((i) => i.budgetId === budgetId);
  assert.ok(row, 'budget should appear in /progress');
  // 150 not 0: only the $50 refunded amount nets out, not the whole $200.
  assert.equal(row!.spent, 150);
});

test('excludeRefundedPurchases: default false keeps refunded original in budget spend', async () => {
  const created = await primaryAgent.post('/api/budgets').send({
    category: 'RefundNoExclude-Test',
    currency: 'CAD',
    amount: 500,
    // flag omitted → defaults to false
  });
  const budgetId = created.body.id as number;
  assert.equal(created.body.excludeRefundedPurchases, false);

  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');

  const refundedOriginalId = await createTransaction(
    primaryHouseholdId,
    primaryAccountId,
    `${y}-${m}-05`,
    'RefundNoExclude-Test',
    -150
  );
  await createRefundLinkedTransaction(
    primaryHouseholdId,
    primaryAccountId,
    `${y}-${m}-10`,
    'RefundNoExclude-Test',
    150,
    refundedOriginalId
  );

  const res = await primaryAgent.get('/api/budgets/progress');
  const items = res.body.items as Array<{
    budgetId: number;
    spent: number;
  }>;
  const row = items.find((i) => i.budgetId === budgetId);
  assert.ok(row);
  // Without the flag, the original $150 still counts even though refunded.
  assert.equal(row!.spent, 150);
});

test('PATCH /:id can toggle excludeRefundedPurchases', async () => {
  const created = await primaryAgent.post('/api/budgets').send({
    category: 'Toggle-Test',
    currency: 'CAD',
    amount: 100,
  });
  const id = created.body.id as number;
  const patched = await primaryAgent
    .patch(`/api/budgets/${id}`)
    .send({ excludeRefundedPurchases: true });
  assert.equal(patched.status, 200);
  assert.equal(patched.body.excludeRefundedPurchases, true);
});
