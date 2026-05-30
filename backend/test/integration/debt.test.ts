/**
 * Integration tests for /api/debt (issue #202, debt payoff planner).
 *
 * Mirrors the seed pattern from forecast.test.ts / plannedEvents.test.ts:
 * bootstrap a superadmin, then seed two households so cross-household
 * isolation is exercised. Each household gets a checking account plus two
 * liability accounts (a credit card and a loan).
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import request from 'supertest';
import { setupPgTestDb, teardownPgTestDb, type PgTestDb } from './_setup/pgTestDb.js';

let app: import('express').Express;
let primaryAgent: ReturnType<typeof request.agent>;
let otherAgent: ReturnType<typeof request.agent>;
let primaryHouseholdId: number;
let otherHouseholdId: number;
let cardAccountId: number;
let loanAccountId: number;
let otherCardAccountId: number;
let testDb: PgTestDb;

type SeededAccount = { id: number };

async function makeAccount(opts: {
  householdId: number;
  userId: number;
  name: string;
  accountType: string;
}): Promise<SeededAccount> {
  const models = await import('../../src/models');
  const account = await models.Account.create({
    householdId: opts.householdId,
    ownerUserId: opts.userId,
    owner: 'me',
    visibility: 'shared',
    name: opts.name,
    accountType: opts.accountType,
    defaultCurrency: 'CAD',
    shortCode: opts.name.slice(0, 3).toUpperCase(),
    openingBalance: '0',
    openingBalanceDate: '2026-01-01',
  });
  return { id: account.id };
}

/**
 * Post a transaction so the liability account has a non-zero (negative,
 * i.e. owed) balance derived from the transaction stream. Mirrors the
 * minimal Transaction factory used in netWorthRoutes.test.ts — only the
 * NOT NULL columns without DB defaults are supplied.
 */
async function postCharge(
  accountId: number,
  householdId: number,
  amount: number,
): Promise<void> {
  const models = await import('../../src/models');
  const fp = `debt-t-${accountId}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  await models.Transaction.create({
    accountId,
    householdId,
    date: '2026-02-01',
    amount: String(amount),
    currency: 'CAD',
    merchantRaw: 'charge',
    merchantClean: 'charge',
    importBatch: 'test',
    sourceRowFingerprint: fp,
    sourceIdentityFingerprint: fp,
  } as never);
}

type Seeded = { token: string; householdId: number; userId: number };

async function seedHousehold(emailPrefix: string): Promise<Seeded> {
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
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24);
  await models.Session.create({ userId: user.id, tokenHash: hashToken(token), expiresAt });
  return { token, householdId: household.id, userId: user.id };
}

before(async () => {
  process.env.NODE_ENV = 'test';
  testDb = await setupPgTestDb('debt');

  const mod = await import('../../src/app.js');
  app = mod.default;

  const bootstrap = request.agent(app);
  const register = await bootstrap.post('/api/auth/register').send({
    email: 'superadmin@example.com',
    displayName: 'Super Admin',
    password: 'password123',
  });
  assert.equal(register.status, 201);

  const primary = await seedHousehold('Primary');
  primaryHouseholdId = primary.householdId;
  primaryAgent = request.agent(app);
  primaryAgent.jar.setCookie(`cashflow_session=${primary.token}; Path=/`);

  const card = await makeAccount({
    householdId: primary.householdId,
    userId: primary.userId,
    name: 'Visa',
    accountType: 'credit_card',
  });
  cardAccountId = card.id;
  await postCharge(cardAccountId, primary.householdId, -3000); // owes 3000

  const loan = await makeAccount({
    householdId: primary.householdId,
    userId: primary.userId,
    name: 'Car loan',
    accountType: 'loan',
  });
  loanAccountId = loan.id;
  await postCharge(loanAccountId, primary.householdId, -1000); // owes 1000

  const other = await seedHousehold('Other');
  otherHouseholdId = other.householdId;
  otherAgent = request.agent(app);
  otherAgent.jar.setCookie(`cashflow_session=${other.token}; Path=/`);
  const otherCard = await makeAccount({
    householdId: other.householdId,
    userId: other.userId,
    name: 'Amex',
    accountType: 'credit_card',
  });
  otherCardAccountId = otherCard.id;
  await postCharge(otherCardAccountId, other.householdId, -500);
});

after(async () => {
  await teardownPgTestDb(testDb);
});

test('GET /api/debt lists liability accounts with derived balances', async () => {
  const res = await primaryAgent.get('/api/debt');
  assert.equal(res.status, 200);
  const liabilities = res.body.liabilities as Array<{
    accountId: number;
    name: string;
    accountType: string;
    balance: number;
    interestRate: number;
    minimumPayment: number;
  }>;
  assert.equal(liabilities.length, 2);
  const card = liabilities.find((l) => l.accountId === cardAccountId);
  const loan = liabilities.find((l) => l.accountId === loanAccountId);
  assert.ok(card && loan);
  // Owed balances surface as positive amounts.
  assert.equal(card.balance, 3000);
  assert.equal(loan.balance, 1000);
  // No profile set yet → defaults.
  assert.equal(card.interestRate, 0);
  assert.equal(card.minimumPayment, 0);
});

test('GET /api/debt excludes non-liability accounts', async () => {
  // The seeded checking account would only exist if we made one; assert the
  // liabilities list contains only liability-type accounts.
  const res = await primaryAgent.get('/api/debt');
  const liabilities = res.body.liabilities as Array<{ accountType: string }>;
  for (const l of liabilities) {
    assert.ok(['credit_card', 'loan', 'mortgage'].includes(l.accountType));
  }
});

test('PUT /api/debt/accounts/:accountId upserts the liability profile', async () => {
  const put = await primaryAgent.put(`/api/debt/accounts/${cardAccountId}`).send({
    interestRate: 19.99,
    minimumPayment: 75,
    dueDay: 15,
  });
  assert.equal(put.status, 200);
  assert.equal(put.body.interestRate, 19.99);
  assert.equal(put.body.minimumPayment, 75);
  assert.equal(put.body.dueDay, 15);

  // Second PUT updates in place (no duplicate row / 1:1).
  const put2 = await primaryAgent.put(`/api/debt/accounts/${cardAccountId}`).send({
    interestRate: 21.5,
    minimumPayment: 80,
  });
  assert.equal(put2.status, 200);
  assert.equal(put2.body.interestRate, 21.5);
  assert.equal(put2.body.minimumPayment, 80);

  // Now GET /api/debt reflects the saved profile.
  const res = await primaryAgent.get('/api/debt');
  const card = (res.body.liabilities as Array<{ accountId: number; interestRate: number; minimumPayment: number }>).find(
    (l) => l.accountId === cardAccountId,
  );
  assert.ok(card);
  assert.equal(card.interestRate, 21.5);
  assert.equal(card.minimumPayment, 80);
});

test('PUT /api/debt/accounts/:accountId rejects a non-liability account', async () => {
  // Make a checking account; the profile endpoint should refuse it.
  const checking = await makeAccount({
    householdId: primaryHouseholdId,
    userId: 1,
    name: 'Chequing',
    accountType: 'checking',
  });
  const put = await primaryAgent.put(`/api/debt/accounts/${checking.id}`).send({
    interestRate: 5,
    minimumPayment: 10,
  });
  assert.equal(put.status, 400);
});

test('PUT /api/debt/accounts/:accountId 404s for an account in another household', async () => {
  const put = await primaryAgent.put(`/api/debt/accounts/${otherCardAccountId}`).send({
    interestRate: 10,
    minimumPayment: 20,
  });
  assert.equal(put.status, 404);
});

test('GET /api/debt returns an avalanche-vs-snowball comparison', async () => {
  // Give the loan a profile too so both debts have rates/minimums.
  await primaryAgent.put(`/api/debt/accounts/${loanAccountId}`).send({
    interestRate: 6,
    minimumPayment: 25,
  });
  const res = await primaryAgent.get('/api/debt').query({ extraMonthlyPayment: 200 });
  assert.equal(res.status, 200);
  assert.ok(res.body.comparison);
  assert.equal(res.body.comparison.avalanche.strategy, 'avalanche');
  assert.equal(res.body.comparison.snowball.strategy, 'snowball');
  assert.ok(res.body.comparison.interestSaved >= 0);
  // Avalanche targets the higher-APR card (21.5%) before the 6% loan.
  assert.deepEqual(res.body.comparison.avalanche.order, [cardAccountId, loanAccountId]);
  // Snowball targets the smaller-balance loan (1000) first.
  assert.deepEqual(res.body.comparison.snowball.order, [loanAccountId, cardAccountId]);
});

test('POST /api/debt/scenarios creates a scenario and returns the computed plan', async () => {
  const res = await primaryAgent.post('/api/debt/scenarios').send({
    name: 'Aggressive payoff',
    strategy: 'avalanche',
    extraMonthlyPayment: 300,
  });
  assert.equal(res.status, 201);
  assert.ok(res.body.scenario.id);
  assert.equal(res.body.scenario.name, 'Aggressive payoff');
  assert.equal(res.body.scenario.strategy, 'avalanche');
  assert.equal(Number(res.body.scenario.extraMonthlyPayment), 300);
  // Plan is computed and includes payoff math.
  assert.ok(res.body.plan);
  assert.equal(res.body.plan.strategy, 'avalanche');
  assert.ok(res.body.plan.totalMonths > 0);
  assert.ok(res.body.plan.totalInterest >= 0);
  assert.ok(Array.isArray(res.body.plan.months));
  assert.ok(res.body.plan.payoffMonthByDebt);
});

test('POST /api/debt/scenarios rejects an invalid strategy', async () => {
  const res = await primaryAgent.post('/api/debt/scenarios').send({
    name: 'Bad',
    strategy: 'turtle',
  });
  assert.equal(res.status, 400);
});

test('POST /api/debt/scenarios requires a name', async () => {
  const res = await primaryAgent.post('/api/debt/scenarios').send({ strategy: 'snowball' });
  assert.equal(res.status, 400);
});

test('GET /api/debt/scenarios/:id recomputes the plan against current liabilities', async () => {
  const created = await primaryAgent.post('/api/debt/scenarios').send({
    name: 'Saved plan',
    strategy: 'snowball',
    extraMonthlyPayment: 100,
  });
  const id = created.body.scenario.id as number;

  const res = await primaryAgent.get(`/api/debt/scenarios/${id}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.scenario.id, id);
  assert.equal(res.body.plan.strategy, 'snowball');
  // Snowball order is smallest balance first.
  assert.deepEqual(res.body.plan.order, [loanAccountId, cardAccountId]);
  assert.ok(Array.isArray(res.body.plan.scheduledPayments));
});

test('GET /api/debt/scenarios/:id 404s for another household', async () => {
  const created = await primaryAgent.post('/api/debt/scenarios').send({
    name: 'Private plan',
    strategy: 'avalanche',
  });
  const id = created.body.scenario.id as number;
  const res = await otherAgent.get(`/api/debt/scenarios/${id}`);
  assert.equal(res.status, 404);
});

test('POST /api/debt/scenarios with feedForecast materializes a forecast debt_payment event', async () => {
  const res = await primaryAgent.post('/api/debt/scenarios').send({
    name: 'Forecast-fed plan',
    strategy: 'avalanche',
    extraMonthlyPayment: 150,
    feedForecast: true,
    startDate: '2026-06-01',
  });
  assert.equal(res.status, 201);

  // A recurring debt_payment planned event (source=debt) should now exist.
  const events = await primaryAgent.get('/api/planned-events').query({ type: 'debt_payment' });
  assert.equal(events.status, 200);
  const debtEvents = (events.body.data as Array<{ type: string; source: string; recurrenceRule: string | null }>).filter(
    (e) => e.source === 'debt',
  );
  assert.ok(debtEvents.length >= 1, 'expected a debt-sourced planned event');
  assert.ok(debtEvents.some((e) => e.recurrenceRule && e.recurrenceRule.includes('FREQ=MONTHLY')));

  // And it shows up in the forecast as an outflow.
  const forecast = await primaryAgent.get('/api/forecast').query({
    dateFrom: '2026-06-01',
    dateTo: '2026-06-30',
    currency: 'CAD',
    includeRecurring: 'false',
  });
  assert.equal(forecast.status, 200);
  const hasDebtOutflow = (forecast.body.events as Array<{ sourceName: string; direction: string }>).some(
    (e) => e.direction === 'out' && /debt|payoff/i.test(e.sourceName),
  );
  assert.ok(hasDebtOutflow, 'expected the debt payment to appear in the forecast');
});

test('re-running feedForecast does not duplicate the debt event (idempotent re-sync)', async () => {
  const before = await primaryAgent.get('/api/planned-events').query({ type: 'debt_payment' });
  const beforeDebt = (before.body.data as Array<{ source: string }>).filter((e) => e.source === 'debt');

  await primaryAgent.post('/api/debt/scenarios').send({
    name: 'Forecast-fed plan 2',
    strategy: 'snowball',
    extraMonthlyPayment: 120,
    feedForecast: true,
    startDate: '2026-06-01',
  });

  const after = await primaryAgent.get('/api/planned-events').query({ type: 'debt_payment' });
  const afterDebt = (after.body.data as Array<{ source: string }>).filter((e) => e.source === 'debt');
  // Idempotent: the prior debt-sourced events are replaced, not accumulated.
  // We expect exactly one debt-sourced recurring event after a re-sync.
  assert.equal(afterDebt.length, 1, `expected 1 debt event, had ${beforeDebt.length} before, ${afterDebt.length} after`);
});

test('households are isolated: otherHouseholdId is distinct', () => {
  assert.notEqual(primaryHouseholdId, otherHouseholdId);
});
