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
  currency = 'CAD'
): Promise<void> {
  const models = await import('../../src/models');
  await models.Transaction.create({
    accountId,
    householdId,
    visibility: 'shared',
    ownershipType: 'me',
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
}

before(async () => {
  testDb = await setupPgTestDb('budgets');

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
