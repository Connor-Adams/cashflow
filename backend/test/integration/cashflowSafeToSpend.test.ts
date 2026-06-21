/**
 * Integration tests for GET /api/forecast/safe-to-spend (issue #199).
 *
 * Each test mints its own seed data (separate household per test) so
 * scenarios don't bleed: one verifies the default-defaults path with a
 * single account, another adds a planned expense, another adds a goal,
 * another adds a credit-card account, another exercises a negative result.
 * Cross-household isolation is exercised at the end.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import request from 'supertest';
import { testAgent } from './_setup/testServer.js';
import { setupPgTestDb, teardownPgTestDb, type PgTestDb } from './_setup/pgTestDb.js';

let app: import('express').Express;
let testDb: PgTestDb;

type Seeded = {
  token: string;
  householdId: number;
  userId: number;
  accountId: number;
  agent: ReturnType<typeof request.agent>;
};

async function seed(emailPrefix: string, accountType = 'chequing'): Promise<Seeded> {
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
    name: `${emailPrefix} ${accountType}`,
    accountType,
    defaultCurrency: 'CAD',
    shortCode: emailPrefix.slice(0, 3).toUpperCase(),
    openingBalance: '0',
  });
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24);
  await models.Session.create({
    userId: user.id,
    tokenHash: hashToken(token),
    expiresAt,
  });
  const agent = testAgent(app);
  agent.jar.setCookie(`cashflow_session=${token}; Path=/`);
  return {
    token,
    householdId: household.id,
    userId: user.id,
    accountId: account.id,
    agent,
  };
}

async function seedCash(
  accountId: number,
  householdId: number,
  amount: number,
  date = '2026-01-01',
): Promise<void> {
  const models = await import('../../src/models');
  await models.Transaction.create({
    accountId,
    householdId,
    visibility: 'shared',
    ownershipType: 'me',
    importBatch: 'safe-to-spend-test',
    date,
    merchantRaw: 'Seed Deposit',
    merchantClean: 'Seed Deposit',
    amount: amount.toFixed(4),
    currency: 'CAD',
    sourceRowFingerprint: crypto.randomBytes(16).toString('hex'),
    sourceIdentityFingerprint: crypto.randomBytes(16).toString('hex'),
  });
}

before(async () => {
  process.env.NODE_ENV = 'test';

  testDb = await setupPgTestDb('cashflow_safe_to_spend');

  const mod = await import('../../src/app.js');
  app = mod.default;

  const bootstrap = testAgent(app);
  const register = await bootstrap.post('/api/auth/register').send({
    email: 'superadmin@example.com',
    displayName: 'Super Admin',
    password: 'password123',
  });
  assert.equal(register.status, 201);
});

after(async () => {
  await teardownPgTestDb(testDb);
});

test('GET /api/forecast/safe-to-spend uses defaults and computes cash-only baseline', async () => {
  const u = await seed('Baseline');
  await seedCash(u.accountId, u.householdId, 2000);

  const res = await u.agent.get('/api/forecast/safe-to-spend?asOfDate=2026-06-01');
  assert.equal(res.status, 200);
  assert.equal(res.body.currency, 'CAD');
  assert.equal(res.body.asOfDate, '2026-06-01');
  assert.equal(res.body.windowDays, 14);
  assert.equal(res.body.value, 2000);
  assert.equal(res.body.isNegative, false);
  assert.equal(res.body.breakdown.currentCash, 2000);
  assert.equal(res.body.breakdown.upcomingRequiredExpenses, 0);
  assert.equal(res.body.breakdown.requiredSavingsContributions, 0);
  assert.equal(res.body.breakdown.expectedCreditCardPayments, 0);
  assert.equal(res.body.breakdown.minimumBuffer, 0);
});

test('upcoming planned expense reduces safe-to-spend', async () => {
  const u = await seed('PlannedExpense');
  await seedCash(u.accountId, u.householdId, 3000);

  const models = await import('../../src/models');
  await models.PlannedEvent.create({
    userId: u.userId,
    householdId: u.householdId,
    accountId: u.accountId,
    type: 'expense',
    name: 'Rent',
    amount: '1500',
    currency: 'CAD',
    expectedDate: '2026-06-10',
    status: 'planned',
    source: 'manual',
  });

  const res = await u.agent.get('/api/forecast/safe-to-spend?asOfDate=2026-06-01');
  assert.equal(res.status, 200);
  // 3000 cash - 1500 expense - 0 - 0 - 0 = 1500
  assert.equal(res.body.value, 1500);
  assert.equal(res.body.breakdown.upcomingRequiredExpenses, 1500);
});

test('planned expense outside window is not counted', async () => {
  const u = await seed('OutsideWindow');
  await seedCash(u.accountId, u.householdId, 3000);

  const models = await import('../../src/models');
  // Default window is 14 days; place expense 60 days out.
  await models.PlannedEvent.create({
    userId: u.userId,
    householdId: u.householdId,
    accountId: u.accountId,
    type: 'expense',
    name: 'Vacation',
    amount: '1000',
    currency: 'CAD',
    expectedDate: '2026-08-01',
    status: 'planned',
    source: 'manual',
  });

  const res = await u.agent.get('/api/forecast/safe-to-spend?asOfDate=2026-06-01');
  assert.equal(res.status, 200);
  assert.equal(res.body.value, 3000);
  assert.equal(res.body.breakdown.upcomingRequiredExpenses, 0);
});

test('minimumCashBuffer setting subtracts from safe-to-spend', async () => {
  const u = await seed('Buffer');
  await seedCash(u.accountId, u.householdId, 5000);

  // Set a 1000 buffer.
  const patch = await u.agent.patch('/api/settings/cashflow').send({
    minimumCashBuffer: 1000,
  });
  assert.equal(patch.status, 200);

  const res = await u.agent.get('/api/forecast/safe-to-spend?asOfDate=2026-06-01');
  assert.equal(res.status, 200);
  assert.equal(res.body.value, 4000);
  assert.equal(res.body.breakdown.minimumBuffer, 1000);
  assert.equal(res.body.settings.minimumCashBuffer, '1000.0000');
});

test('credit-card balance is subtracted as expected payment', async () => {
  const u = await seed('CC');
  await seedCash(u.accountId, u.householdId, 3000);

  const models = await import('../../src/models');
  // Add a CC account with a -500 balance (i.e. user owes 500).
  const ccAcct = await models.Account.create({
    householdId: u.householdId,
    ownerUserId: u.userId,
    owner: 'me',
    visibility: 'shared',
    name: 'CC',
    accountType: 'credit_card',
    defaultCurrency: 'CAD',
    shortCode: 'CCC',
    openingBalance: '0',
  });
  await models.Transaction.create({
    accountId: ccAcct.id,
    householdId: u.householdId,
    visibility: 'shared',
    ownershipType: 'me',
    importBatch: 'safe-to-spend-test',
    date: '2026-01-01',
    merchantRaw: 'CC Purchases',
    merchantClean: 'CC Purchases',
    amount: '-500.0000',
    currency: 'CAD',
    sourceRowFingerprint: crypto.randomBytes(16).toString('hex'),
    sourceIdentityFingerprint: crypto.randomBytes(16).toString('hex'),
  });

  const res = await u.agent.get('/api/forecast/safe-to-spend?asOfDate=2026-06-01');
  assert.equal(res.status, 200);
  // 3000 cash - 500 CC owed = 2500. CC account is NOT in currentCash
  // because CASH_EXCLUDED_TYPES drops credit_card.
  assert.equal(res.body.breakdown.currentCash, 3000);
  assert.equal(res.body.breakdown.expectedCreditCardPayments, 500);
  assert.equal(res.body.value, 2500);
});

test('includeCreditCardBalance=false zeroes the CC deduction', async () => {
  const u = await seed('CCOff');
  await seedCash(u.accountId, u.householdId, 3000);

  const models = await import('../../src/models');
  const ccAcct = await models.Account.create({
    householdId: u.householdId,
    ownerUserId: u.userId,
    owner: 'me',
    visibility: 'shared',
    name: 'CC',
    accountType: 'credit_card',
    defaultCurrency: 'CAD',
    shortCode: 'CCC',
    openingBalance: '0',
  });
  await models.Transaction.create({
    accountId: ccAcct.id,
    householdId: u.householdId,
    visibility: 'shared',
    ownershipType: 'me',
    importBatch: 'safe-to-spend-test',
    date: '2026-01-01',
    merchantRaw: 'CC Purchases',
    merchantClean: 'CC Purchases',
    amount: '-500.0000',
    currency: 'CAD',
    sourceRowFingerprint: crypto.randomBytes(16).toString('hex'),
    sourceIdentityFingerprint: crypto.randomBytes(16).toString('hex'),
  });

  await u.agent.patch('/api/settings/cashflow').send({
    includeCreditCardBalance: false,
  });

  const res = await u.agent.get('/api/forecast/safe-to-spend?asOfDate=2026-06-01');
  assert.equal(res.status, 200);
  assert.equal(res.body.breakdown.expectedCreditCardPayments, 0);
  assert.equal(res.body.value, 3000);
});

test('financial goal required monthly contribution is subtracted', async () => {
  const u = await seed('Goal');
  await seedCash(u.accountId, u.householdId, 5000);

  const models = await import('../../src/models');
  // Goal with a user-declared monthly contribution and no target date.
  await models.FinancialGoal.create({
    userId: u.userId,
    householdId: u.householdId,
    name: 'Emergency fund',
    targetAmount: '10000',
    currentAmount: '0',
    currency: 'CAD',
    monthlyContribution: '300',
    status: 'active',
  });

  const res = await u.agent.get('/api/forecast/safe-to-spend?asOfDate=2026-06-01');
  assert.equal(res.status, 200);
  // $300/mo goal contribution prorated to the default 14-day window:
  // 300 * 14/30 = 140. Then 5000 - 0 - 140 goal - 0 - 0 = 4860.
  assert.equal(res.body.breakdown.requiredSavingsContributions, 140);
  assert.equal(res.body.value, 4860);
});

test('includeGoalContributions=false zeroes the goal deduction', async () => {
  const u = await seed('GoalOff');
  await seedCash(u.accountId, u.householdId, 5000);

  const models = await import('../../src/models');
  await models.FinancialGoal.create({
    userId: u.userId,
    householdId: u.householdId,
    name: 'Emergency fund',
    targetAmount: '10000',
    currentAmount: '0',
    currency: 'CAD',
    monthlyContribution: '300',
    status: 'active',
  });

  await u.agent.patch('/api/settings/cashflow').send({
    includeGoalContributions: false,
  });

  const res = await u.agent.get('/api/forecast/safe-to-spend?asOfDate=2026-06-01');
  assert.equal(res.status, 200);
  assert.equal(res.body.breakdown.requiredSavingsContributions, 0);
  assert.equal(res.body.value, 5000);
});

test('safe-to-spend goes negative and surfaces isNegative=true', async () => {
  const u = await seed('Negative');
  await seedCash(u.accountId, u.householdId, 500);

  const models = await import('../../src/models');
  await models.PlannedEvent.create({
    userId: u.userId,
    householdId: u.householdId,
    accountId: u.accountId,
    type: 'expense',
    name: 'Rent',
    amount: '2000',
    currency: 'CAD',
    expectedDate: '2026-06-10',
    status: 'planned',
    source: 'manual',
  });

  const res = await u.agent.get('/api/forecast/safe-to-spend?asOfDate=2026-06-01');
  assert.equal(res.status, 200);
  // 500 - 2000 = -1500
  assert.equal(res.body.value, -1500);
  assert.equal(res.body.isNegative, true);
});

test('cross-household isolation: other household sees no leak', async () => {
  const a = await seed('IsoA');
  const b = await seed('IsoB');
  await seedCash(a.accountId, a.householdId, 1234);
  await seedCash(b.accountId, b.householdId, 5678);

  const models = await import('../../src/models');
  await models.PlannedEvent.create({
    userId: a.userId,
    householdId: a.householdId,
    accountId: a.accountId,
    type: 'expense',
    name: 'Rent',
    amount: '200',
    currency: 'CAD',
    expectedDate: '2026-06-10',
    status: 'planned',
    source: 'manual',
  });

  const resA = await a.agent.get('/api/forecast/safe-to-spend?asOfDate=2026-06-01');
  const resB = await b.agent.get('/api/forecast/safe-to-spend?asOfDate=2026-06-01');
  // A: 1234 - 200 = 1034
  assert.equal(resA.body.value, 1034);
  // B sees its own cash with no expense (A's planned event is in A's household).
  assert.equal(resB.body.value, 5678);
});

test('rejects bad currency code', async () => {
  const u = await seed('BadCcy');
  const res = await u.agent.get(
    '/api/forecast/safe-to-spend?asOfDate=2026-06-01&currency=CADX',
  );
  assert.equal(res.status, 400);
});

test('rejects bad asOfDate', async () => {
  const u = await seed('BadDate');
  const res = await u.agent.get('/api/forecast/safe-to-spend?asOfDate=06-01-2026');
  assert.equal(res.status, 400);
});

test('unauthenticated request returns 401', async () => {
  const fresh = testAgent(app);
  const res = await fresh.get('/api/forecast/safe-to-spend');
  assert.equal(res.status, 401);
});
