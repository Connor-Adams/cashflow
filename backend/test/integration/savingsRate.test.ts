/**
 * Integration tests for /api/reports/savings-rate (Cashflow #246).
 *
 * Mirrors the bootstrap pattern from lifestyleInflation.test.ts: seed a
 * superadmin to satisfy the global registration guard, then seed a
 * non-superadmin household for the primary asserts. Cross-household isolation
 * is asserted via a second seeded household.
 *
 * The primary household gets four accounts — a checking account (income +
 * spend + transfer-out legs), a savings account (deposits), an investment
 * account (contributions), and a loan account (principal payments) — so we can
 * prove each component is classified onto the right bucket and that internal
 * transfers are not double counted.
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
let checkingId: number;
let savingsId: number;
let investmentId: number;
let loanId: number;
let otherAgent: ReturnType<typeof request.agent>;
let otherHouseholdId: number;
let otherCheckingId: number;
let testDb: PgTestDb;

type Seeded = {
  token: string;
  householdId: number;
  userId: number;
};

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
  await models.Session.create({
    userId: user.id,
    tokenHash: hashToken(token),
    expiresAt,
  });
  return { token, householdId: household.id, userId: user.id };
}

async function seedAccount(opts: {
  householdId: number;
  ownerUserId: number;
  name: string;
  accountType: string;
  shortCode: string;
}): Promise<number> {
  const models = await import('../../src/models');
  const account = await models.Account.create({
    householdId: opts.householdId,
    ownerUserId: opts.ownerUserId,
    owner: 'me',
    visibility: 'shared',
    name: opts.name,
    accountType: opts.accountType,
    defaultCurrency: 'CAD',
    shortCode: opts.shortCode,
  });
  return account.id;
}

interface SeedTxnArgs {
  householdId: number;
  accountId: number;
  createdByUserId?: number | null;
  date: string;
  amount: number; // signed
  merchant?: string;
  currency?: string;
  txnType?: string;
  transferPurpose?: string | null;
  visibility?: 'shared' | 'private';
}

async function seedTxn(args: SeedTxnArgs): Promise<number> {
  const models = await import('../../src/models');
  const txn = await models.Transaction.create({
    accountId: args.accountId,
    householdId: args.householdId,
    visibility: args.visibility ?? 'shared',
    ownershipType: 'me',
    ownershipContactId: null,
    importBatch: 'savings-rate-test',
    date: args.date,
    merchantRaw: args.merchant ?? 'Test merchant',
    merchantClean: args.merchant ?? 'Test merchant',
    amount: args.amount.toFixed(4),
    currency: args.currency ?? 'CAD',
    txnType: args.txnType ?? 'purchase',
    transferPurpose: args.transferPurpose ?? null,
    notes: null,
    sourceReference: null,
    sourceRowFingerprint: crypto.randomBytes(16).toString('hex'),
    sourceIdentityFingerprint: crypto.randomBytes(16).toString('hex'),
    appliedRuleId: null,
    autoCategory: null,
    categoryOverride: null,
    finalCategory: null,
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
    createdByUserId: args.createdByUserId ?? null,
  });
  return txn.id;
}

/**
 * Seed one month with a full set of money movements:
 *   income 5000 (checking) | spend 2000 (checking) | save 1000 (savings)
 *   invest 500 (investment) | debt principal 500 (loan)
 * plus the transfer-out legs on checking for the save/invest/debt moves, which
 * must NOT be counted as spending.
 */
async function seedFullMonth(month: string): Promise<void> {
  await seedTxn({
    householdId: primaryHouseholdId,
    accountId: checkingId,
    createdByUserId: primaryUserId,
    date: `${month}-28`,
    amount: 5000,
    merchant: 'Payroll',
    txnType: 'income',
  });
  await seedTxn({
    householdId: primaryHouseholdId,
    accountId: checkingId,
    createdByUserId: primaryUserId,
    date: `${month}-15`,
    amount: -2000,
    merchant: 'Groceries',
    txnType: 'purchase',
  });
  // Transfer-out legs on checking (must be skipped, not counted as spend).
  await seedTxn({
    householdId: primaryHouseholdId,
    accountId: checkingId,
    createdByUserId: primaryUserId,
    date: `${month}-16`,
    amount: -1000,
    merchant: 'To savings',
    txnType: 'transfer',
  });
  await seedTxn({
    householdId: primaryHouseholdId,
    accountId: checkingId,
    createdByUserId: primaryUserId,
    date: `${month}-17`,
    amount: -500,
    merchant: 'To brokerage',
    txnType: 'transfer',
    transferPurpose: 'investment',
  });
  await seedTxn({
    householdId: primaryHouseholdId,
    accountId: checkingId,
    createdByUserId: primaryUserId,
    date: `${month}-18`,
    amount: -500,
    merchant: 'Loan payment',
    txnType: 'transfer',
  });
  // Destination legs.
  await seedTxn({
    householdId: primaryHouseholdId,
    accountId: savingsId,
    createdByUserId: primaryUserId,
    date: `${month}-16`,
    amount: 1000,
    merchant: 'From checking',
    txnType: 'transfer',
  });
  await seedTxn({
    householdId: primaryHouseholdId,
    accountId: investmentId,
    createdByUserId: primaryUserId,
    date: `${month}-17`,
    amount: 500,
    merchant: 'Contribution',
    txnType: 'transfer',
  });
  await seedTxn({
    householdId: primaryHouseholdId,
    accountId: loanId,
    createdByUserId: primaryUserId,
    date: `${month}-18`,
    amount: 500,
    merchant: 'Principal',
    txnType: 'payment',
  });
}

before(async () => {
  testDb = await setupPgTestDb('savings-rate');

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
  primaryUserId = primary.userId;
  primaryAgent = request.agent(app);
  primaryAgent.jar.setCookie(`cashflow_session=${primary.token}; Path=/`);

  checkingId = await seedAccount({
    householdId: primaryHouseholdId,
    ownerUserId: primaryUserId,
    name: 'Checking',
    accountType: 'checking',
    shortCode: 'CHK',
  });
  savingsId = await seedAccount({
    householdId: primaryHouseholdId,
    ownerUserId: primaryUserId,
    name: 'Savings',
    accountType: 'savings',
    shortCode: 'SAV',
  });
  investmentId = await seedAccount({
    householdId: primaryHouseholdId,
    ownerUserId: primaryUserId,
    name: 'Brokerage',
    accountType: 'investment',
    shortCode: 'INV',
  });
  loanId = await seedAccount({
    householdId: primaryHouseholdId,
    ownerUserId: primaryUserId,
    name: 'Mortgage',
    accountType: 'loan',
    shortCode: 'LON',
  });

  const other = await seedHousehold('Other');
  otherHouseholdId = other.householdId;
  otherAgent = request.agent(app);
  otherAgent.jar.setCookie(`cashflow_session=${other.token}; Path=/`);
  otherCheckingId = await seedAccount({
    householdId: otherHouseholdId,
    ownerUserId: other.userId,
    name: 'Other checking',
    accountType: 'checking',
    shortCode: 'OTH',
  });

  // Primary: a full month of movements in 2024-03.
  await seedFullMonth('2024-03');
});

after(async () => {
  await teardownPgTestDb(testDb);
});

test('rejects a malformed month query param', async () => {
  const res = await primaryAgent.get('/api/reports/savings-rate?month=not-a-month');
  assert.equal(res.status, 400);
  assert.match(res.body.error, /month/);
});

test('returns the requested window with no data gracefully', async () => {
  const res = await primaryAgent.get('/api/reports/savings-rate?month=2020-06&months=6');
  assert.equal(res.status, 200);
  assert.equal(res.body.anchorMonth, '2020-06');
  assert.equal(res.body.windowMonths.length, 6);
  assert.equal(res.body.includeInvestments, true);
  assert.equal(res.body.includeDebtPrincipal, true);
  assert.deepEqual(res.body.byCurrency, []);
});

test('classifies each component onto the right bucket', async () => {
  const res = await primaryAgent.get(
    '/api/reports/savings-rate?month=2024-06&months=6&currency=CAD',
  );
  assert.equal(res.status, 200);
  assert.equal(res.body.scope, 'all');
  assert.equal(res.body.currency, 'CAD');
  const cad = (res.body.byCurrency as Array<{
    currency: string;
    series: Array<{
      month: string;
      income: number;
      spending: number;
      savings: number;
      investments: number;
      debtPrincipal: number;
      savingsRatePct: number | null;
    }>;
  }>).find((c) => c.currency === 'CAD')!;
  assert.ok(cad, 'expected a CAD summary');
  const mar = cad.series.find((m) => m.month === '2024-03')!;
  assert.equal(mar.income, 5000);
  // Only the real grocery purchase counts as spend; the three transfer-out
  // legs (1000 + 500 + 500) must NOT inflate spending.
  assert.equal(mar.spending, 2000);
  assert.equal(mar.savings, 1000);
  assert.equal(mar.investments, 500);
  assert.equal(mar.debtPrincipal, 500);
  // (1000 + 500 + 500) / 5000 = 40%
  assert.equal(mar.savingsRatePct, 40);
});

test('reports window totals and an overall savings rate', async () => {
  const res = await primaryAgent.get(
    '/api/reports/savings-rate?month=2024-06&months=6&currency=CAD',
  );
  const cad = (res.body.byCurrency as Array<{
    currency: string;
    totals: {
      income: number;
      spending: number;
      savings: number;
      investments: number;
      debtPrincipal: number;
      savingsRatePct: number | null;
    };
  }>).find((c) => c.currency === 'CAD')!;
  assert.equal(cad.totals.income, 5000);
  assert.equal(cad.totals.savings, 1000);
  assert.equal(cad.totals.investments, 500);
  assert.equal(cad.totals.debtPrincipal, 500);
  assert.equal(cad.totals.savingsRatePct, 40);
});

test('includeInvestments=false and includeDebtPrincipal=false change the rate', async () => {
  const res = await primaryAgent.get(
    '/api/reports/savings-rate?month=2024-06&months=6&currency=CAD&includeInvestments=false&includeDebtPrincipal=false',
  );
  assert.equal(res.body.includeInvestments, false);
  assert.equal(res.body.includeDebtPrincipal, false);
  const cad = (res.body.byCurrency as Array<{
    currency: string;
    series: Array<{ month: string; savingsRatePct: number | null; investments: number; debtPrincipal: number }>;
  }>).find((c) => c.currency === 'CAD')!;
  const mar = cad.series.find((m) => m.month === '2024-03')!;
  // Only cash savings now: 1000 / 5000 = 20%.
  assert.equal(mar.savingsRatePct, 20);
  // Components are still reported even when excluded from the numerator.
  assert.equal(mar.investments, 500);
  assert.equal(mar.debtPrincipal, 500);
});

test('respects the currency filter', async () => {
  // Seed a USD income + savings in the window; must not appear under CAD.
  await seedTxn({
    householdId: primaryHouseholdId,
    accountId: checkingId,
    createdByUserId: primaryUserId,
    date: '2024-05-28',
    amount: 2000,
    merchant: 'USD payroll',
    txnType: 'income',
    currency: 'USD',
  });
  await seedTxn({
    householdId: primaryHouseholdId,
    accountId: savingsId,
    createdByUserId: primaryUserId,
    date: '2024-05-16',
    amount: 200,
    merchant: 'USD save',
    txnType: 'transfer',
    currency: 'USD',
  });
  const cad = await primaryAgent.get(
    '/api/reports/savings-rate?month=2024-06&months=6&currency=CAD',
  );
  for (const c of cad.body.byCurrency as Array<{ currency: string }>) {
    assert.equal(c.currency, 'CAD');
  }
  const usd = await primaryAgent.get(
    '/api/reports/savings-rate?month=2024-06&months=6&currency=USD',
  );
  const usdSummaries = usd.body.byCurrency as Array<{ currency: string }>;
  assert.equal(usdSummaries.length, 1);
  assert.equal(usdSummaries[0].currency, 'USD');
});

test('respects the scope filter (personal hides shared activity)', async () => {
  // All primary activity is visibility=shared. A personal-scope query
  // (visibility=private) should therefore see no CAD summary.
  const res = await primaryAgent.get(
    '/api/reports/savings-rate?month=2024-06&months=6&currency=CAD&scope=personal',
  );
  assert.equal(res.status, 200);
  assert.equal(res.body.scope, 'personal');
  const cad = (res.body.byCurrency as Array<{ currency: string }>).find((c) => c.currency === 'CAD');
  assert.equal(cad, undefined, 'shared activity must be excluded from personal scope');
});

test('is household-isolated', async () => {
  // Seed income under the OTHER household; the primary report must not see it.
  await seedTxn({
    householdId: otherHouseholdId,
    accountId: otherCheckingId,
    createdByUserId: null,
    date: '2024-03-28',
    amount: 99999,
    merchant: 'Other payroll',
    txnType: 'income',
  });
  const primaryRes = await primaryAgent.get(
    '/api/reports/savings-rate?month=2024-06&months=6&currency=CAD',
  );
  const primaryCad = (primaryRes.body.byCurrency as Array<{
    currency: string;
    series: Array<{ month: string; income: number }>;
  }>).find((c) => c.currency === 'CAD')!;
  const mar = primaryCad.series.find((m) => m.month === '2024-03')!;
  // Primary March income is still 5000 — the other household's did not leak in.
  assert.equal(mar.income, 5000);

  const otherRes = await otherAgent.get(
    '/api/reports/savings-rate?month=2024-06&months=6&currency=CAD',
  );
  const otherCad = (otherRes.body.byCurrency as Array<{ currency: string }>).find(
    (c) => c.currency === 'CAD',
  );
  assert.ok(otherCad, 'other household sees its own CAD summary');
});

test('clamps the window size into a sane range', async () => {
  const big = await primaryAgent.get('/api/reports/savings-rate?month=2024-06&months=999');
  assert.equal(big.body.windowMonths.length, 36);
  const tiny = await primaryAgent.get('/api/reports/savings-rate?month=2024-06&months=1');
  assert.ok(tiny.body.windowMonths.length >= 2);
});
