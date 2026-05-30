/**
 * Integration tests for /api/reports/lifestyle-inflation (Cashflow #245).
 *
 * Mirrors the bootstrap pattern from explainMonth.test.ts: seed a superadmin
 * to satisfy the global registration guard, then seed a non-superadmin
 * household for primary asserts. Cross-household isolation is asserted via a
 * second seeded agent.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import request from 'supertest';
import { setupPgTestDb, teardownPgTestDb, type PgTestDb } from './_setup/pgTestDb.js';

let app: import('express').Express;
let primaryAgent: ReturnType<typeof request.agent>;
let primaryHouseholdId: number;
let primaryUserId: number;
let primaryAccountId: number;
let primaryInvestmentAccountId: number;
let otherAgent: ReturnType<typeof request.agent>;
let otherHouseholdId: number;
let otherAccountId: number;
let testDb: PgTestDb;

type Seeded = {
  token: string;
  householdId: number;
  userId: number;
  accountId: number;
};

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

async function seedInvestmentAccount(householdId: number, ownerUserId: number): Promise<number> {
  const models = await import('../../src/models');
  const account = await models.Account.create({
    householdId,
    ownerUserId,
    owner: 'me',
    visibility: 'shared',
    name: 'Brokerage',
    accountType: 'investment',
    defaultCurrency: 'CAD',
    shortCode: 'INV',
  });
  return account.id;
}

interface SeedTxnArgs {
  householdId: number;
  accountId: number;
  createdByUserId?: number | null;
  date: string;
  amount: number; // signed: negative = spend, positive = income
  category?: string | null;
  merchant?: string;
  currency?: string;
  txnType?: string;
  business?: boolean;
  visibility?: 'shared' | 'private';
  ownershipType?: 'me' | 'partner';
}

async function seedTxn(args: SeedTxnArgs): Promise<number> {
  const models = await import('../../src/models');
  const txn = await models.Transaction.create({
    accountId: args.accountId,
    householdId: args.householdId,
    visibility: args.visibility ?? 'shared',
    ownershipType: args.ownershipType ?? 'me',
    ownershipContactId: null,
    importBatch: 'lifestyle-inflation-test',
    date: args.date,
    merchantRaw: args.merchant ?? 'Test merchant',
    merchantClean: args.merchant ?? 'Test merchant',
    amount: args.amount.toFixed(4),
    currency: args.currency ?? 'CAD',
    txnType: args.txnType ?? 'purchase',
    notes: null,
    sourceReference: null,
    sourceRowFingerprint: crypto.randomBytes(16).toString('hex'),
    sourceIdentityFingerprint: crypto.randomBytes(16).toString('hex'),
    appliedRuleId: null,
    autoCategory: null,
    categoryOverride: null,
    finalCategory: args.category ?? null,
    autoBusiness: null,
    businessOverride: args.business ?? null,
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
    createdByUserId: args.createdByUserId ?? null,
  });
  return txn.id;
}

/** Seed a flat income + ramping-spend series for a 6-month window so the
 *  report has clear lifestyle inflation: spend roughly doubles in the second
 *  half while income stays flat. */
async function seedInflationSeries(opts: {
  householdId: number;
  accountId: number;
  createdByUserId?: number | null;
  months: string[]; // ascending, length 6
  currency?: string;
}): Promise<void> {
  const spendByIndex = [1000, 1000, 1000, 2000, 2100, 2200];
  for (let i = 0; i < opts.months.length; i++) {
    const m = opts.months[i];
    await seedTxn({
      householdId: opts.householdId,
      accountId: opts.accountId,
      createdByUserId: opts.createdByUserId,
      date: `${m}-15`,
      amount: -(spendByIndex[i] ?? 1000),
      category: 'Dining',
      merchant: 'Resto',
      currency: opts.currency,
    });
    await seedTxn({
      householdId: opts.householdId,
      accountId: opts.accountId,
      createdByUserId: opts.createdByUserId,
      date: `${m}-28`,
      amount: 3000,
      category: null,
      merchant: 'Payroll',
      currency: opts.currency,
    });
  }
}

const WINDOW = ['2024-01', '2024-02', '2024-03', '2024-04', '2024-05', '2024-06'];

before(async () => {
  testDb = await setupPgTestDb('lifestyle-inflation');

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
  primaryUserId = primary.userId;
  primaryAccountId = primary.accountId;
  primaryInvestmentAccountId = await seedInvestmentAccount(primaryHouseholdId, primaryUserId);
  primaryAgent = request.agent(app);
  primaryAgent.jar.setCookie(`cashflow_session=${primary.token}; Path=/`);

  const other = await seed('Other');
  otherHouseholdId = other.householdId;
  otherAccountId = other.accountId;
  otherAgent = request.agent(app);
  otherAgent.jar.setCookie(`cashflow_session=${other.token}; Path=/`);

  // Primary household: a clear inflation series in CAD over the 6-month window.
  await seedInflationSeries({
    householdId: primaryHouseholdId,
    accountId: primaryAccountId,
    createdByUserId: primaryUserId,
    months: WINDOW,
  });
});

after(async () => {
  await teardownPgTestDb(testDb);
});

test('rejects a malformed month query param', async () => {
  const res = await primaryAgent.get('/api/reports/lifestyle-inflation?month=not-a-month');
  assert.equal(res.status, 400);
  assert.match(res.body.error, /month/);
});

test('returns the requested window with no data gracefully', async () => {
  // A window far from any seeded data — series present, all zeros, no insight.
  const res = await primaryAgent.get(
    '/api/reports/lifestyle-inflation?month=2020-06&months=6',
  );
  assert.equal(res.status, 200);
  assert.equal(res.body.anchorMonth, '2020-06');
  assert.equal(res.body.windowMonths.length, 6);
  assert.deepEqual(res.body.byCurrency, []);
});

test('returns a per-currency monthly income/spend series', async () => {
  const res = await primaryAgent.get(
    '/api/reports/lifestyle-inflation?month=2024-06&months=6&currency=CAD',
  );
  assert.equal(res.status, 200);
  assert.equal(res.body.scope, 'all');
  assert.equal(res.body.currency, 'CAD');
  const cad = (res.body.byCurrency as Array<{ currency: string; series: unknown[] }>).find(
    (c) => c.currency === 'CAD',
  );
  assert.ok(cad, 'expected a CAD trend');
  assert.equal(cad!.series.length, 6);
  const series = cad!.series as Array<{ month: string; income: number; spend: number; savings: number }>;
  assert.equal(series[0].month, '2024-01');
  assert.equal(series[0].income, 3000);
  assert.equal(series[0].spend, 1000);
  assert.equal(series[0].savings, 2000);
  assert.equal(series[5].month, '2024-06');
  assert.equal(series[5].spend, 2200);
});

test('flags spending outpacing income with an insight', async () => {
  const res = await primaryAgent.get(
    '/api/reports/lifestyle-inflation?month=2024-06&months=6&currency=CAD',
  );
  const cad = (res.body.byCurrency as Array<{
    currency: string;
    spendOutpacingIncome: boolean;
    insight: { kind: string; severity: string; summary: string } | null;
    categoryDrivers: Array<{ category: string; delta: number }>;
  }>).find((c) => c.currency === 'CAD')!;
  assert.equal(cad.spendOutpacingIncome, true);
  assert.ok(cad.insight, 'expected a lifestyle_inflation insight');
  assert.equal(cad.insight!.kind, 'lifestyle_inflation');
  assert.ok(['low', 'medium', 'high'].includes(cad.insight!.severity));
  // Dining is the lone spend category and ramped up — it must be the driver.
  assert.ok(cad.categoryDrivers.length >= 1);
  assert.equal(cad.categoryDrivers[0].category, 'Dining');
  assert.ok(cad.categoryDrivers[0].delta > 0);
});

test('excludes transfers and investment-account activity from the trend', async () => {
  // Seed a huge transfer + a brokerage buy in the same window; neither should
  // move the spend series. Use a fresh anchor month set to keep asserts simple.
  await seedTxn({
    householdId: primaryHouseholdId,
    accountId: primaryAccountId,
    createdByUserId: primaryUserId,
    date: '2024-03-05',
    amount: -50000,
    category: 'Transfer',
    merchant: 'Internal move',
    txnType: 'transfer',
  });
  await seedTxn({
    householdId: primaryHouseholdId,
    accountId: primaryInvestmentAccountId,
    createdByUserId: primaryUserId,
    date: '2024-03-06',
    amount: -25000,
    category: null,
    merchant: 'BUY VEQT',
    txnType: 'purchase',
  });
  const res = await primaryAgent.get(
    '/api/reports/lifestyle-inflation?month=2024-06&months=6&currency=CAD',
  );
  const cad = (res.body.byCurrency as Array<{ currency: string; series: Array<{ month: string; spend: number }> }>).find(
    (c) => c.currency === 'CAD',
  )!;
  const mar = cad.series.find((m) => m.month === '2024-03')!;
  // March spend should still be the original 1000, not 1000 + 50000 + 25000.
  assert.equal(mar.spend, 1000);
});

test('respects the currency filter', async () => {
  // Seed a USD spend in the window; it must not appear under a CAD filter.
  await seedTxn({
    householdId: primaryHouseholdId,
    accountId: primaryAccountId,
    createdByUserId: primaryUserId,
    date: '2024-05-10',
    amount: -250,
    category: 'Travel',
    merchant: 'Hotel',
    currency: 'USD',
  });
  const cad = await primaryAgent.get(
    '/api/reports/lifestyle-inflation?month=2024-06&months=6&currency=CAD',
  );
  for (const c of cad.body.byCurrency as Array<{ currency: string }>) {
    assert.equal(c.currency, 'CAD');
  }
  const usd = await primaryAgent.get(
    '/api/reports/lifestyle-inflation?month=2024-06&months=6&currency=USD',
  );
  const usdTrends = usd.body.byCurrency as Array<{ currency: string }>;
  assert.equal(usdTrends.length, 1);
  assert.equal(usdTrends[0].currency, 'USD');
});

test('respects the scope filter (personal hides shared spend)', async () => {
  // All primary spend so far is visibility=shared. A personal-scope query
  // (visibility=private) should therefore see no CAD trend.
  const res = await primaryAgent.get(
    '/api/reports/lifestyle-inflation?month=2024-06&months=6&currency=CAD&scope=personal',
  );
  assert.equal(res.status, 200);
  assert.equal(res.body.scope, 'personal');
  const cad = (res.body.byCurrency as Array<{ currency: string }>).find((c) => c.currency === 'CAD');
  assert.equal(cad, undefined, 'shared spend must be excluded from personal scope');
});

test('is household-isolated', async () => {
  // Seed a noisy series under the OTHER household; the primary report must
  // not see it, and the other household sees only its own data.
  await seedInflationSeries({
    householdId: otherHouseholdId,
    accountId: otherAccountId,
    createdByUserId: null, // visibility=shared makes rows visible to their own household
    months: WINDOW,
  });
  const primaryRes = await primaryAgent.get(
    '/api/reports/lifestyle-inflation?month=2024-06&months=6&currency=CAD',
  );
  const primaryCad = (primaryRes.body.byCurrency as Array<{ currency: string; series: Array<{ month: string; spend: number }> }>).find(
    (c) => c.currency === 'CAD',
  )!;
  // Primary March spend is still 1000 — the other household's 1000 did not leak in.
  const mar = primaryCad.series.find((m) => m.month === '2024-03')!;
  assert.equal(mar.spend, 1000);

  const otherRes = await otherAgent.get(
    '/api/reports/lifestyle-inflation?month=2024-06&months=6&currency=CAD',
  );
  const otherCad = (otherRes.body.byCurrency as Array<{ currency: string }>).find(
    (c) => c.currency === 'CAD',
  );
  assert.ok(otherCad, 'other household sees its own CAD trend');
});

test('clamps the window size into a sane range', async () => {
  // months=999 should clamp to 36; months=1 should clamp to >=2.
  const big = await primaryAgent.get(
    '/api/reports/lifestyle-inflation?month=2024-06&months=999',
  );
  assert.equal(big.body.windowMonths.length, 36);
  const tiny = await primaryAgent.get(
    '/api/reports/lifestyle-inflation?month=2024-06&months=1',
  );
  assert.ok(tiny.body.windowMonths.length >= 2);
});
