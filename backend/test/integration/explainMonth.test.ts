/**
 * Integration tests for /api/reports/explain-month (Cashflow #225).
 *
 * Mirrors the bootstrap pattern from moneyLeaks.test.ts: seed a superadmin
 * to satisfy the global registration guard, then seed a non-superadmin
 * household for primary asserts. Cross-household isolation is asserted via
 * a second seeded agent.
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

interface SeedTxnArgs {
  householdId: number;
  accountId: number;
  createdByUserId?: number | null;
  date: string;
  amount: number; // signed: negative = spend
  category?: string | null;
  merchant?: string;
  currency?: string;
  reviewFlag?: boolean;
  business?: boolean;
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
    importBatch: 'explain-month-test',
    date: args.date,
    merchantRaw: args.merchant ?? 'Test merchant',
    merchantClean: args.merchant ?? 'Test merchant',
    amount: args.amount.toFixed(4),
    currency: args.currency ?? 'CAD',
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
    reviewFlag: args.reviewFlag ?? false,
    reviewedAt: null,
    createdByUserId: args.createdByUserId ?? null,
  });
  return txn.id;
}

// Map a legacy Subscription status to the merged PlannedEvent (kind='subscription')
// status + statusUncertain pair. Mirrors fromSubscriptionStatus in
// src/expectations/subscriptionMapper.ts; the explain-month route reads these
// rows back through serializeSubscription, which reconstructs the legacy
// `status` (e.g. 'cancelled' drives the cancelled-this-month finding).
function subscriptionStatusFields(
  status: 'active' | 'cancelled' | 'ignored' | 'unknown',
): { status: 'planned' | 'cancelled' | 'ignored'; statusUncertain: boolean } {
  switch (status) {
    case 'cancelled':
      return { status: 'cancelled', statusUncertain: false };
    case 'ignored':
      return { status: 'ignored', statusUncertain: false };
    case 'unknown':
      return { status: 'planned', statusUncertain: true };
    case 'active':
    default:
      return { status: 'planned', statusUncertain: false };
  }
}

async function seedSubscription(args: {
  householdId: number;
  merchant: string;
  amount: number;
  currency?: string;
  status?: 'active' | 'cancelled' | 'ignored' | 'unknown';
  priceChangeDetected?: boolean;
  lastChargeDate?: string;
  category?: string | null;
  createdAt?: string;
  updatedAt?: string;
}): Promise<void> {
  const models = await import('../../src/models');
  const lastChargeDate =
    args.lastChargeDate ?? new Date().toISOString().slice(0, 10);
  const owner = (
    await models.HouseholdMember.findOne({
      where: { householdId: args.householdId, role: 'owner' },
      attributes: ['userId'],
      raw: true,
    })
  )!.userId;
  const sub = await models.PlannedEvent.create({
    kind: 'subscription',
    type: 'expense',
    source: 'recurring_detection',
    userId: owner,
    householdId: args.householdId,
    name: args.merchant,
    normalizedName: args.merchant.toLowerCase(),
    amount: args.amount.toFixed(4),
    currency: args.currency ?? 'CAD',
    cadence: 'monthly',
    lastChargeDate,
    nextExpectedDate: null,
    // expectedDate (NOT NULL) = nextExpectedDate ?? lastChargeDate.
    expectedDate: lastChargeDate,
    category: args.category ?? null,
    annualizedCost: (args.amount * 12).toFixed(4),
    priceChangeDetected: args.priceChangeDetected ?? false,
    cancellationUrl: null,
    notes: null,
    ...subscriptionStatusFields(args.status ?? 'active'),
  });
  // Override createdAt / updatedAt timestamps if requested — Sequelize sets
  // them automatically on create() and the route's "new this month"
  // detector relies on them. We must use Model.update with silent:true to
  // bypass Sequelize's auto-bump of updatedAt; setting on the instance and
  // calling save() does not write to the createdAt column.
  if (args.createdAt || args.updatedAt) {
    const patch: Record<string, Date> = {};
    if (args.createdAt) patch.createdAt = new Date(args.createdAt);
    if (args.updatedAt) patch.updatedAt = new Date(args.updatedAt);
    await models.PlannedEvent.update(patch, {
      where: { id: sub.id, kind: 'subscription' },
      silent: true,
    });
  }
}

before(async () => {
  testDb = await setupPgTestDb('explain-month');

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

test('GET /api/reports/explain-month rejects missing month query param', async () => {
  const res = await primaryAgent.get('/api/reports/explain-month');
  assert.equal(res.status, 400);
  assert.match(res.body.error, /month/);
});

test('GET /api/reports/explain-month rejects malformed month', async () => {
  const res = await primaryAgent.get('/api/reports/explain-month?month=not-a-month');
  assert.equal(res.status, 400);
});

test('GET /api/reports/explain-month returns empty result for empty period', async () => {
  const res = await primaryAgent.get('/api/reports/explain-month?month=2024-07');
  assert.equal(res.status, 200);
  assert.equal(res.body.month, '2024-07');
  assert.equal(res.body.previousMonth, '2024-06');
  assert.deepEqual(res.body.monthOverMonth, []);
  assert.deepEqual(res.body.findings, []);
  assert.equal(res.body.aiSummary, null);
});

test('GET /api/reports/explain-month returns spend_change and missing_receipt findings', async () => {
  // Previous month: 100 spent on Groceries
  await seedTxn({
    householdId: primaryHouseholdId,
    accountId: primaryAccountId,
    createdByUserId: primaryUserId,
    date: '2024-08-15',
    amount: -100,
    category: 'Groceries',
    merchant: 'Loblaws',
  });
  // Current month: 300 spent on Groceries (delta = -200, more spend)
  await seedTxn({
    householdId: primaryHouseholdId,
    accountId: primaryAccountId,
    createdByUserId: primaryUserId,
    date: '2024-09-10',
    amount: -300,
    category: 'Groceries',
    merchant: 'Loblaws',
  });
  // Big-ticket spend with no receipt
  await seedTxn({
    householdId: primaryHouseholdId,
    accountId: primaryAccountId,
    createdByUserId: primaryUserId,
    date: '2024-09-12',
    amount: -200,
    category: 'Electronics',
    merchant: 'Best Buy',
  });

  const res = await primaryAgent.get('/api/reports/explain-month?month=2024-09');
  assert.equal(res.status, 200);
  assert.equal(res.body.month, '2024-09');
  const findings = res.body.findings as Array<{
    kind: string;
    currency: string;
    monthlyImpact: number;
    transactionFilter?: Record<string, unknown>;
  }>;
  const spendChange = findings.find((f) => f.kind === 'spend_change');
  assert.ok(spendChange, 'expected at least one spend_change finding');
  const missingReceipt = findings.find((f) => f.kind === 'missing_receipt');
  assert.ok(missingReceipt, 'expected a missing_receipt finding');
});

test('GET /api/reports/explain-month surfaces subscription_change for new subscription', async () => {
  await seedSubscription({
    householdId: primaryHouseholdId,
    merchant: 'NewSaaS',
    amount: 9.99,
    category: 'Software',
    createdAt: '2024-09-05T00:00:00Z',
    updatedAt: '2024-09-05T00:00:00Z',
  });
  const res = await primaryAgent.get('/api/reports/explain-month?month=2024-09');
  const subs = (res.body.findings as Array<{ kind: string; title: string }>).filter(
    (f) => f.kind === 'subscription_change',
  );
  assert.ok(subs.length >= 1);
  assert.ok(subs.some((s) => /NewSaaS/.test(s.title)));
});

test('GET /api/reports/explain-month respects currency filter', async () => {
  // Seed USD transaction in same month — should be excluded when filter is CAD.
  await seedTxn({
    householdId: primaryHouseholdId,
    accountId: primaryAccountId,
    createdByUserId: primaryUserId,
    date: '2024-09-15',
    amount: -75,
    category: 'Travel',
    merchant: 'Hotel',
    currency: 'USD',
  });
  const cad = await primaryAgent.get('/api/reports/explain-month?month=2024-09&currency=CAD');
  const cadFindings = cad.body.findings as Array<{ currency: string }>;
  for (const f of cadFindings) {
    assert.equal(f.currency, 'CAD');
  }
  for (const m of cad.body.monthOverMonth as Array<{ currency: string }>) {
    assert.equal(m.currency, 'CAD');
  }

  const usd = await primaryAgent.get('/api/reports/explain-month?month=2024-09&currency=USD');
  const usdMom = usd.body.monthOverMonth as Array<{ currency: string }>;
  assert.equal(usdMom.length, 1);
  assert.equal(usdMom[0].currency, 'USD');
});

test('GET /api/reports/explain-month surfaces review_needed when reviewFlag txns present', async () => {
  await seedTxn({
    householdId: primaryHouseholdId,
    accountId: primaryAccountId,
    createdByUserId: primaryUserId,
    date: '2024-09-20',
    amount: -42,
    category: 'Misc',
    merchant: 'ToReview',
    reviewFlag: true,
  });
  const res = await primaryAgent.get('/api/reports/explain-month?month=2024-09&currency=CAD');
  const review = (res.body.findings as Array<{ kind: string; meta?: { count?: number } }>).find(
    (f) => f.kind === 'review_needed',
  );
  assert.ok(review, 'expected a review_needed finding');
});

test('GET /api/reports/explain-month?ai=true degrades to null when no OPENAI_API_KEY', async () => {
  const oldKey = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  try {
    const res = await primaryAgent.get('/api/reports/explain-month?month=2024-09&currency=CAD&ai=true');
    assert.equal(res.status, 200);
    assert.equal(res.body.aiSummary, null);
  } finally {
    if (oldKey != null) process.env.OPENAI_API_KEY = oldKey;
  }
});

test('GET /api/reports/explain-month is household-isolated', async () => {
  // Seed a noisy txn under the OTHER household for the same month —
  // it must not appear in the primary household's report.
  await seedTxn({
    householdId: otherHouseholdId,
    accountId: otherAccountId,
    date: '2024-09-25',
    amount: -999,
    category: 'Travel',
    merchant: 'OtherHouseholdMerchant',
    visibility: 'shared',
  });
  const res = await primaryAgent.get('/api/reports/explain-month?month=2024-09');
  const merchants = (res.body.findings as Array<{ summary: string }>)
    .map((f) => f.summary)
    .join(' | ');
  assert.ok(!/OtherHouseholdMerchant/.test(merchants));

  const otherRes = await otherAgent.get('/api/reports/explain-month?month=2024-09');
  // The other household sees only their own data (or a finding referencing
  // their merchant — depending on threshold).
  const otherFindings = otherRes.body.findings as Array<{ summary: string }>;
  // 999 in Travel exceeds the missing-receipt threshold (50), so we expect
  // their household to surface the OtherHouseholdMerchant txn.
  const hasOther = otherFindings.some((f) => /OtherHouseholdMerchant/.test(f.summary));
  assert.ok(hasOther);
});
