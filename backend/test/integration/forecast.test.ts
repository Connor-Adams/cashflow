/**
 * Integration tests for /api/forecast (issue #198).
 *
 * Mirrors the seed pattern from plannedEvents.test.ts: bootstrap a
 * superadmin, then seed two non-superadmin households so cross-household
 * isolation can be exercised. Each household has its own checking account.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import request from 'supertest';
import { setupPgTestDb, teardownPgTestDb, type PgTestDb } from './_setup/pgTestDb.js';

let app: import('express').Express;
let primaryAgent: ReturnType<typeof request.agent>;
let primaryHouseholdId: number;
let primaryAccountId: number;
let otherAgent: ReturnType<typeof request.agent>;
let otherAccountId: number;
let otherHouseholdId: number;
let testDb: PgTestDb;

type Seeded = {
  token: string;
  householdId: number;
  userId: number;
  accountId: number;
};

async function seed(emailPrefix: string, opts: { openingBalance?: number } = {}): Promise<Seeded> {
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
    name: `${emailPrefix} checking`,
    accountType: 'checking',
    defaultCurrency: 'CAD',
    shortCode: emailPrefix.slice(0, 3).toUpperCase(),
    openingBalance: String(opts.openingBalance ?? 0),
    openingBalanceDate: '2026-01-01',
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

before(async () => {
  process.env.NODE_ENV = 'test';
  testDb = await setupPgTestDb('forecast');

  const mod = await import('../../src/app.js');
  app = mod.default;

  const bootstrap = request.agent(app);
  const register = await bootstrap.post('/api/auth/register').send({
    email: 'superadmin@example.com',
    displayName: 'Super Admin',
    password: 'password123',
  });
  assert.equal(register.status, 201);

  const primary = await seed('Primary', { openingBalance: 5000 });
  primaryHouseholdId = primary.householdId;
  primaryAccountId = primary.accountId;
  primaryAgent = request.agent(app);
  primaryAgent.jar.setCookie(`cashflow_session=${primary.token}; Path=/`);

  const other = await seed('Other', { openingBalance: 2000 });
  otherHouseholdId = other.householdId;
  otherAccountId = other.accountId;
  otherAgent = request.agent(app);
  otherAgent.jar.setCookie(`cashflow_session=${other.token}; Path=/`);
});

after(async () => {
  await teardownPgTestDb(testDb);
});

test('GET /api/forecast returns the expected shape with no events', async () => {
  const res = await primaryAgent
    .get('/api/forecast')
    .query({ dateFrom: '2026-06-01', dateTo: '2026-06-07', currency: 'CAD' });
  assert.equal(res.status, 200);
  assert.equal(res.body.currency, 'CAD');
  assert.equal(res.body.dateFrom, '2026-06-01');
  assert.equal(res.body.dateTo, '2026-06-07');
  assert.equal(res.body.openingBalance, 5000);
  assert.equal(res.body.projectedClosingBalance, 5000);
  assert.equal(res.body.lowestProjectedBalance, 5000);
  assert.equal(res.body.dailyPoints.length, 7);
  assert.deepEqual(
    res.body.dailyPoints.map((p: { date: string }) => p.date),
    [
      '2026-06-01',
      '2026-06-02',
      '2026-06-03',
      '2026-06-04',
      '2026-06-05',
      '2026-06-06',
      '2026-06-07',
    ],
  );
  for (const point of res.body.dailyPoints) {
    assert.equal(point.balance, 5000);
  }
  assert.deepEqual(res.body.events, []);
});

test('GET /api/forecast incorporates a one-off planned expense', async () => {
  // Add an expense of 800 on June 4. Opening 5000 → closing 4200, low 4200.
  const created = await primaryAgent.post('/api/planned-events').send({
    type: 'expense',
    name: 'Quarterly tax',
    amount: 800,
    currency: 'CAD',
    expectedDate: '2026-06-04',
    accountId: primaryAccountId,
  });
  assert.equal(created.status, 201);

  const res = await primaryAgent
    .get('/api/forecast')
    .query({ dateFrom: '2026-06-01', dateTo: '2026-06-07', currency: 'CAD', includeRecurring: 'false' });
  assert.equal(res.status, 200);
  assert.equal(res.body.openingBalance, 5000);
  assert.equal(res.body.projectedClosingBalance, 4200);
  assert.equal(res.body.lowestProjectedBalance, 4200);
  assert.equal(res.body.lowestProjectedBalanceDate, '2026-06-04');
  // Day 3 still 5000; day 4 onward 4200
  const points = res.body.dailyPoints as Array<{ date: string; balance: number }>;
  assert.equal(points.find((p) => p.date === '2026-06-03')?.balance, 5000);
  assert.equal(points.find((p) => p.date === '2026-06-04')?.balance, 4200);
  assert.equal(points.find((p) => p.date === '2026-06-07')?.balance, 4200);
  const taxEvent = (res.body.events as Array<{ sourceName: string; direction: string; amount: number }>).find(
    (e) => e.sourceName === 'Quarterly tax',
  );
  assert.ok(taxEvent, 'expected the quarterly tax event in response.events');
  assert.equal(taxEvent.direction, 'out');
  assert.equal(taxEvent.amount, 800);
});

test('GET /api/forecast expands a recurring planned income across the window', async () => {
  // Paycheck of 1500 on the 15th of each month, starting May 15.
  // Forecast June 1 - Aug 31 → 3 occurrences: June 15, July 15, Aug 15.
  const created = await primaryAgent.post('/api/planned-events').send({
    type: 'income',
    name: 'Paycheck',
    amount: 1500,
    currency: 'CAD',
    expectedDate: '2026-05-15',
    recurrenceRule: 'FREQ=MONTHLY;BYMONTHDAY=15',
  });
  assert.equal(created.status, 201);

  const res = await primaryAgent
    .get('/api/forecast')
    .query({
      dateFrom: '2026-06-01',
      dateTo: '2026-08-31',
      currency: 'CAD',
      includeRecurring: 'false',
    });
  assert.equal(res.status, 200);
  const events = res.body.events as Array<{
    sourceName: string;
    direction: string;
    date: string;
    amount: number;
  }>;
  const paychecks = events.filter((e) => e.sourceName === 'Paycheck');
  assert.equal(paychecks.length, 3, `expected 3 paycheck occurrences, got ${paychecks.length}`);
  assert.deepEqual(
    paychecks.map((p) => p.date).sort(),
    ['2026-06-15', '2026-07-15', '2026-08-15'],
  );
  for (const p of paychecks) {
    assert.equal(p.direction, 'in');
    assert.equal(p.amount, 1500);
  }
});

test('GET /api/forecast lowestProjectedBalance reflects a mid-range dip', async () => {
  // We already have the Quarterly tax (800 out on 6/4) and Paychecks
  // (1500 in on 6/15, 7/15, 8/15). Add a big 4500 out on 6/10 to drive
  // the lowest balance into mid-June. Opening 5000.
  //
  // Timeline:
  // 6/01 +0 → 5000
  // 6/04 -800 → 4200
  // 6/10 -4500 → -300  ← lowest
  // 6/15 +1500 → 1200
  // ...
  const created = await primaryAgent.post('/api/planned-events').send({
    type: 'expense',
    name: 'Roof repair',
    amount: 4500,
    currency: 'CAD',
    expectedDate: '2026-06-10',
    accountId: primaryAccountId,
  });
  assert.equal(created.status, 201);

  const res = await primaryAgent
    .get('/api/forecast')
    .query({
      dateFrom: '2026-06-01',
      dateTo: '2026-06-30',
      currency: 'CAD',
      includeRecurring: 'false',
    });
  assert.equal(res.status, 200);
  assert.equal(res.body.lowestProjectedBalance, -300);
  assert.equal(res.body.lowestProjectedBalanceDate, '2026-06-10');
});

test('GET /api/forecast rejects invalid date format', async () => {
  const res = await primaryAgent
    .get('/api/forecast')
    .query({ dateFrom: '06/01/2026' });
  assert.equal(res.status, 400);
});

test('GET /api/forecast rejects dateTo < dateFrom', async () => {
  const res = await primaryAgent
    .get('/api/forecast')
    .query({ dateFrom: '2026-06-10', dateTo: '2026-06-01' });
  assert.equal(res.status, 400);
});

test('GET /api/forecast rejects bad currency code', async () => {
  const res = await primaryAgent.get('/api/forecast').query({ currency: 'EU' });
  assert.equal(res.status, 400);
});

test('GET /api/forecast rejects horizon > MAX days', async () => {
  const res = await primaryAgent
    .get('/api/forecast')
    .query({ dateFrom: '2026-06-01', dateTo: '2030-06-01' });
  assert.equal(res.status, 400);
});

test('GET /api/forecast supports accountId filter', async () => {
  const res = await primaryAgent
    .get('/api/forecast')
    .query({
      dateFrom: '2026-06-01',
      dateTo: '2026-06-07',
      currency: 'CAD',
      accountId: String(primaryAccountId),
      includeRecurring: 'false',
    });
  assert.equal(res.status, 200);
  assert.equal(res.body.openingBalance, 5000);
});

test('GET /api/forecast does not leak rows from another household', async () => {
  // Other household adds a 999 expense; primary forecast should not see it.
  const otherEvent = await otherAgent.post('/api/planned-events').send({
    type: 'expense',
    name: 'Confidential',
    amount: 999,
    currency: 'CAD',
    expectedDate: '2026-06-05',
    accountId: otherAccountId,
  });
  assert.equal(otherEvent.status, 201);

  const res = await primaryAgent
    .get('/api/forecast')
    .query({
      dateFrom: '2026-06-01',
      dateTo: '2026-06-07',
      currency: 'CAD',
      includeRecurring: 'false',
    });
  assert.equal(res.status, 200);
  const eventNames = (res.body.events as Array<{ sourceName: string }>).map((e) => e.sourceName);
  assert.ok(!eventNames.includes('Confidential'));

  // Other household sees its own event.
  const otherRes = await otherAgent
    .get('/api/forecast')
    .query({
      dateFrom: '2026-06-01',
      dateTo: '2026-06-07',
      currency: 'CAD',
      includeRecurring: 'false',
    });
  assert.equal(otherRes.status, 200);
  const otherEventNames = (otherRes.body.events as Array<{ sourceName: string }>).map(
    (e) => e.sourceName,
  );
  assert.ok(otherEventNames.includes('Confidential'));
});

test('GET /api/forecast posted events are NOT reprojected', async () => {
  // Add a posted event with a large amount. It should not move the balance.
  const created = await primaryAgent.post('/api/planned-events').send({
    type: 'expense',
    name: 'Already-paid bill',
    amount: 99999,
    currency: 'CAD',
    expectedDate: '2026-06-03',
    accountId: primaryAccountId,
    status: 'posted',
  });
  assert.equal(created.status, 201);

  const res = await primaryAgent
    .get('/api/forecast')
    .query({
      dateFrom: '2026-06-01',
      dateTo: '2026-06-07',
      currency: 'CAD',
      includeRecurring: 'false',
    });
  assert.equal(res.status, 200);
  const events = res.body.events as Array<{ sourceName: string }>;
  assert.ok(!events.some((e) => e.sourceName === 'Already-paid bill'));
});

test('GET /api/forecast skipped events are NOT reprojected', async () => {
  const created = await primaryAgent.post('/api/planned-events').send({
    type: 'expense',
    name: 'Dismissed bill',
    amount: 12345,
    currency: 'CAD',
    expectedDate: '2026-06-04',
    accountId: primaryAccountId,
    status: 'skipped',
  });
  assert.equal(created.status, 201);

  const res = await primaryAgent
    .get('/api/forecast')
    .query({
      dateFrom: '2026-06-01',
      dateTo: '2026-06-07',
      currency: 'CAD',
      includeRecurring: 'false',
    });
  assert.equal(res.status, 200);
  const events = res.body.events as Array<{ sourceName: string }>;
  assert.ok(!events.some((e) => e.sourceName === 'Dismissed bill'));
});

test('GET /api/forecast accepts default date range without args', async () => {
  // No dateFrom/dateTo — should default to today → today+30 days.
  const res = await primaryAgent
    .get('/api/forecast')
    .query({ currency: 'CAD', includeRecurring: 'false' });
  assert.equal(res.status, 200);
  assert.ok(res.body.dailyPoints.length >= 30);
  assert.ok(res.body.dailyPoints.length <= 32);
});

test('GET /api/forecast 404s for unknown account', async () => {
  const res = await primaryAgent
    .get('/api/forecast')
    .query({
      dateFrom: '2026-06-01',
      dateTo: '2026-06-07',
      currency: 'CAD',
      accountId: '99999',
      includeRecurring: 'false',
    });
  assert.equal(res.status, 404);
});

test('households are isolated: otherHouseholdId is distinct', () => {
  assert.notEqual(primaryHouseholdId, otherHouseholdId);
});

// ---------------------------------------------------------------------------
// Auto-detected recurring INCOME (the "never earn another dollar" fix).
// The forecast already auto-projects recurring expenses from transaction
// history; these tests pin that it now also projects recurring income that is
// identifiable by a direct-deposit / payroll signal — without sweeping in
// internal transfers.
// ---------------------------------------------------------------------------

let txnFingerprintCounter = 0;
async function seedTxn(opts: {
  accountId: number;
  householdId: number;
  date: string;
  amount: number;
  merchant: string;
  txnType?: string;
  currency?: string;
}): Promise<void> {
  const models = await import('../../src/models');
  txnFingerprintCounter += 1;
  const fp = `fp-${Date.now()}-${txnFingerprintCounter}-${Math.random().toString(16).slice(2)}`;
  await models.Transaction.create({
    accountId: opts.accountId,
    householdId: opts.householdId,
    importBatch: 'forecast-test',
    date: opts.date,
    merchantRaw: opts.merchant,
    merchantClean: opts.merchant,
    amount: String(opts.amount),
    currency: opts.currency ?? 'CAD',
    txnType: opts.txnType ?? 'unknown',
    sourceRowFingerprint: fp,
    sourceIdentityFingerprint: fp,
    reviewFlag: false,
  });
}

test('GET /api/forecast auto-projects recurring direct-deposit income', async () => {
  const h = await seed('Income', { openingBalance: 1000 });
  const agent = request.agent(app);
  agent.jar.setCookie(`cashflow_session=${h.token}; Path=/`);

  // Two monthly payroll deposits, tagged 'transfer' (as real banks do), before
  // the forecast window. The direct-deposit description is the income signal.
  await seedTxn({
    accountId: h.accountId,
    householdId: h.householdId,
    date: '2026-04-15',
    amount: 5000,
    merchant: 'Direct deposit from CDG LABS INC',
    txnType: 'transfer',
  });
  await seedTxn({
    accountId: h.accountId,
    householdId: h.householdId,
    date: '2026-05-15',
    amount: 5000,
    merchant: 'Direct deposit from CDG LABS INC',
    txnType: 'transfer',
  });

  const res = await agent
    .get('/api/forecast')
    .query({ dateFrom: '2026-06-01', dateTo: '2026-06-30', currency: 'CAD' });
  assert.equal(res.status, 200);
  const events = res.body.events as Array<{
    sourceName: string;
    direction: string;
    date: string;
    amount: number;
  }>;
  const income = events.filter((e) => e.direction === 'in');
  assert.equal(income.length, 1, `expected one projected income event, got ${income.length}`);
  assert.match(income[0].sourceName, /CDG LABS INC/i);
  assert.equal(income[0].date, '2026-06-15');
  assert.equal(income[0].amount, 5000);
  // Income lifts the projection above the opening balance.
  assert.equal(
    res.body.projectedClosingBalance - res.body.openingBalance,
    5000,
  );
});

test('GET /api/forecast does NOT project internal transfers as income', async () => {
  const h = await seed('NoPhantom', { openingBalance: 1000 });
  const agent = request.agent(app);
  agent.jar.setCookie(`cashflow_session=${h.token}; Path=/`);

  // Recurring positive inflows that are really self-transfers, not income.
  for (const date of ['2026-04-04', '2026-05-04']) {
    await seedTxn({
      accountId: h.accountId,
      householdId: h.householdId,
      date,
      amount: 2120,
      merchant: 'From chequing account',
      txnType: 'transfer',
    });
  }

  const res = await agent
    .get('/api/forecast')
    .query({ dateFrom: '2026-06-01', dateTo: '2026-06-30', currency: 'CAD' });
  assert.equal(res.status, 200);
  const events = res.body.events as Array<{ direction: string }>;
  assert.equal(events.filter((e) => e.direction === 'in').length, 0);
});

test('GET /api/forecast projects a subscription-kind expectation as an outflow', async () => {
  const h = await seed('Subs', { openingBalance: 1000 });
  const agent = request.agent(app);
  agent.jar.setCookie(`cashflow_session=${h.token}; Path=/`);

  // Subscriptions store a cadence + a (possibly past) seed date and a null
  // recurrenceRule. They were previously excluded from the forecast entirely.
  const models = await import('../../src/models');
  await models.PlannedEvent.create({
    userId: h.userId,
    householdId: h.householdId,
    accountId: h.accountId,
    type: 'expense',
    name: 'Spotify',
    amount: '20',
    currency: 'CAD',
    expectedDate: '2026-03-08',
    nextExpectedDate: '2026-03-08',
    kind: 'subscription',
    cadence: 'monthly',
    source: 'recurring_detection',
    status: 'planned',
  });

  const res = await agent
    .get('/api/forecast')
    .query({
      dateFrom: '2026-06-01',
      dateTo: '2026-06-30',
      currency: 'CAD',
      includeRecurring: 'false',
    });
  assert.equal(res.status, 200);
  const events = res.body.events as Array<{
    sourceName: string;
    direction: string;
    date: string;
    amount: number;
  }>;
  const spotify = events.filter((e) => e.sourceName === 'Spotify');
  assert.equal(spotify.length, 1, `expected one Spotify occurrence, got ${spotify.length}`);
  assert.equal(spotify[0].direction, 'out');
  assert.equal(spotify[0].date, '2026-06-08');
  assert.equal(spotify[0].amount, 20);
  assert.equal(res.body.projectedClosingBalance, 980);
});
