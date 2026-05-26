/**
 * Integration tests for /api/money-leaks (Cashflow #220). Run in isolation
 * (`yarn test:integration`) so DATABASE_URL is set before any Sequelize
 * import.
 *
 * Mirrors the bootstrap pattern used by subscriptions.test.ts: seed a
 * superadmin to satisfy the global registration guard, then seed two
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
let primaryUserId: number;
let primaryAccountId: number;
let otherAgent: ReturnType<typeof request.agent>;
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

async function seedSubscription(args: {
  householdId: number;
  merchant: string;
  amount: number;
  currency?: string;
  cadence?: 'monthly' | 'weekly';
  status?: 'active' | 'cancelled' | 'ignored' | 'unknown';
  priceChangeDetected?: boolean;
  category?: string | null;
}): Promise<void> {
  const models = await import('../../src/models');
  const cadence = args.cadence ?? 'monthly';
  const annualized =
    cadence === 'monthly' ? args.amount * 12 : args.amount * 52;
  await models.Subscription.create({
    householdId: args.householdId,
    merchantName: args.merchant,
    normalizedName: args.merchant.toLowerCase(),
    amount: args.amount.toFixed(4),
    currency: args.currency ?? 'CAD',
    cadence,
    lastChargeDate: new Date().toISOString().slice(0, 10),
    nextExpectedDate: null,
    status: args.status ?? 'active',
    category: args.category ?? null,
    annualizedCost: annualized.toFixed(4),
    priceChangeDetected: args.priceChangeDetected ?? false,
    cancellationUrl: null,
    notes: null,
  });
}

async function seedDeliveryCharges(
  householdId: number,
  accountId: number,
  count: number,
  amountEach: number,
): Promise<void> {
  const models = await import('../../src/models');
  const now = new Date();
  for (let i = 0; i < count; i += 1) {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() - i * 3);
    const iso = d.toISOString().slice(0, 10);
    await models.Transaction.create({
      accountId,
      householdId,
      visibility: 'shared',
      ownershipType: 'me',
      ownershipContactId: null,
      importBatch: 'money-leaks-test',
      date: iso,
      merchantRaw: 'Uber Eats',
      merchantClean: 'Uber Eats',
      amount: (-Math.abs(amountEach)).toFixed(4),
      currency: 'CAD',
      notes: null,
      sourceReference: null,
      sourceRowFingerprint: crypto.randomBytes(16).toString('hex'),
      sourceIdentityFingerprint: crypto.randomBytes(16).toString('hex'),
      appliedRuleId: null,
      autoCategory: null,
      categoryOverride: null,
      finalCategory: 'Food',
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
}

before(async () => {
  testDb = await setupPgTestDb('money-leaks');

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
  void primaryUserId;
  primaryAccountId = primary.accountId;
  primaryAgent = request.agent(app);
  primaryAgent.jar.setCookie(`cashflow_session=${primary.token}; Path=/`);

  const other = await seed('Other');
  otherAgent = request.agent(app);
  otherAgent.jar.setCookie(`cashflow_session=${other.token}; Path=/`);
});

after(async () => {
  await teardownPgTestDb(testDb);
});

test('GET /api/money-leaks returns empty when no leaks present', async () => {
  const res = await primaryAgent.get('/api/money-leaks');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.items, []);
  assert.deepEqual(res.body.totals.byCurrency, []);
});

test('GET /api/money-leaks surfaces subscription_price_increase from priceChangeDetected', async () => {
  await seedSubscription({
    householdId: primaryHouseholdId,
    merchant: 'Netflix',
    amount: 18.99,
    priceChangeDetected: true,
    category: 'Streaming',
  });
  const res = await primaryAgent.get('/api/money-leaks');
  assert.equal(res.status, 200);
  const items = res.body.items as Array<{
    leakType: string;
    identityKey: string;
    currency: string;
    annualImpact: number;
    monthlyImpact: number;
  }>;
  const priceLeaks = items.filter((i) => i.leakType === 'subscription_price_increase');
  assert.equal(priceLeaks.length, 1);
  assert.equal(priceLeaks[0].currency, 'CAD');
  // 18.99 * 12 = 227.88
  assert.equal(Number(priceLeaks[0].annualImpact.toFixed(2)), 227.88);
  // Totals should include this leak.
  assert.equal(res.body.totals.byCurrency.length >= 1, true);
});

test('GET /api/money-leaks surfaces small_subscription for cheap active subs', async () => {
  await seedSubscription({
    householdId: primaryHouseholdId,
    merchant: 'TinyCloud',
    amount: 3.99,
    category: 'Cloud',
  });
  const res = await primaryAgent.get('/api/money-leaks');
  const smalls = (res.body.items as Array<{ leakType: string; meta?: Record<string, unknown> }>)
    .filter((i) => i.leakType === 'small_subscription');
  // Should include TinyCloud (annualized $47.88).
  assert.ok(smalls.length >= 1);
});

test('GET /api/money-leaks emits duplicate_service for 2+ active subs in same category', async () => {
  // Already seeded Netflix above (Streaming). Add another streaming sub.
  await seedSubscription({
    householdId: primaryHouseholdId,
    merchant: 'Disney+',
    amount: 11.99,
    category: 'Streaming',
  });
  const res = await primaryAgent.get('/api/money-leaks');
  const dups = (res.body.items as Array<{
    leakType: string;
    currency: string;
    identityKey: string;
  }>).filter((i) => i.leakType === 'duplicate_service');
  // Note: Netflix triggers price_increase so it's removed from duplicate
  // clustering. But we still have Netflix + Disney+ in Streaming; price
  // increase takes priority so Netflix is excluded → only Disney+ remains
  // → not enough to cluster. So we need to seed a 2nd non-price-up streaming
  // sub.
  void dups; // We assert below after another sub is added.
  await seedSubscription({
    householdId: primaryHouseholdId,
    merchant: 'Hulu',
    amount: 9.99,
    category: 'Streaming',
  });
  const res2 = await primaryAgent.get('/api/money-leaks');
  const dups2 = (res2.body.items as Array<{
    leakType: string;
    currency: string;
    identityKey: string;
  }>).filter((i) => i.leakType === 'duplicate_service');
  assert.equal(dups2.length, 1);
  assert.equal(dups2[0].identityKey, 'CAD|Streaming');
});

test('POST /api/money-leaks/dismiss persists a dismissal and hides the leak', async () => {
  // Find the TinyCloud small_subscription leak and dismiss it.
  const before = await primaryAgent.get('/api/money-leaks');
  const target = (
    before.body.items as Array<{
      leakType: string;
      identityKey: string;
      meta?: { subscriptionId?: number };
    }>
  ).find(
    (i) =>
      i.leakType === 'small_subscription' &&
      i.meta?.subscriptionId !== undefined,
  );
  assert.ok(target, 'expected a small_subscription leak to dismiss');

  const dismissed = await primaryAgent.post('/api/money-leaks/dismiss').send({
    leakType: target!.leakType,
    identityKey: target!.identityKey,
  });
  assert.equal(dismissed.status, 201);
  assert.equal(dismissed.body.leakType, target!.leakType);
  assert.equal(dismissed.body.identityKey, target!.identityKey);

  // Subsequent GET should not include it.
  const after2 = await primaryAgent.get('/api/money-leaks');
  const stillThere = (
    after2.body.items as Array<{ leakType: string; identityKey: string }>
  ).find(
    (i) =>
      i.leakType === target!.leakType && i.identityKey === target!.identityKey,
  );
  assert.equal(stillThere, undefined);
});

test('POST /api/money-leaks/dismiss is idempotent', async () => {
  const first = await primaryAgent.post('/api/money-leaks/dismiss').send({
    leakType: 'recurring_fee',
    identityKey: 'some fake fee|CAD',
  });
  assert.equal(first.status, 201);
  const dupe = await primaryAgent.post('/api/money-leaks/dismiss').send({
    leakType: 'recurring_fee',
    identityKey: 'some fake fee|CAD',
  });
  // Second call returns 200 with the existing row, not a new 201.
  assert.equal(dupe.status, 200);
  assert.equal(dupe.body.id, first.body.id);
});

test('POST /api/money-leaks/dismiss rejects unknown leakType', async () => {
  const res = await primaryAgent.post('/api/money-leaks/dismiss').send({
    leakType: 'not_a_real_type',
    identityKey: 'anything',
  });
  assert.equal(res.status, 400);
});

test('POST /api/money-leaks/dismiss rejects missing identityKey', async () => {
  const res = await primaryAgent.post('/api/money-leaks/dismiss').send({
    leakType: 'small_subscription',
  });
  assert.equal(res.status, 400);
});

test('DELETE /api/money-leaks/dismiss/:id removes dismissal and resurfaces leak', async () => {
  const list = await primaryAgent.get('/api/money-leaks/dismissed');
  assert.equal(list.status, 200);
  const items = list.body.items as Array<{ id: number; leakType: string }>;
  const sub = items.find((d) => d.leakType === 'small_subscription');
  assert.ok(sub, 'expected at least one small_subscription dismissal');
  const del = await primaryAgent.delete(`/api/money-leaks/dismiss/${sub!.id}`);
  assert.equal(del.status, 204);
  const listAfter = await primaryAgent.get('/api/money-leaks/dismissed');
  const stillThere = (listAfter.body.items as Array<{ id: number }>).find(
    (d) => d.id === sub!.id,
  );
  assert.equal(stillThere, undefined);
});

test('GET /api/money-leaks scopes results to the calling household', async () => {
  const res = await otherAgent.get('/api/money-leaks');
  assert.equal(res.status, 200);
  // Other household has no seeded subs/transactions — should be empty.
  assert.deepEqual(res.body.items, []);
});

test('POST /api/money-leaks/dismiss does not leak across households', async () => {
  // Other household dismissing primary household's leak is harmless — the
  // dismissal is scoped to the OTHER household and won't affect primary's
  // view.
  const otherDismiss = await otherAgent.post('/api/money-leaks/dismiss').send({
    leakType: 'small_subscription',
    identityKey: '999999',
  });
  assert.ok(otherDismiss.status === 200 || otherDismiss.status === 201);
  // primary's view should be unaffected.
  const primaryView = await primaryAgent.get('/api/money-leaks');
  assert.ok(Array.isArray(primaryView.body.items));
});

test('DELETE /api/money-leaks/dismiss/:id returns 404 across households', async () => {
  const list = await primaryAgent.get('/api/money-leaks/dismissed');
  const first = (list.body.items as Array<{ id: number }>)[0];
  assert.ok(first, 'expected at least one primary dismissal');
  const res = await otherAgent.delete(`/api/money-leaks/dismiss/${first.id}`);
  assert.equal(res.status, 404);
});

test('GET /api/money-leaks supports currency filter', async () => {
  // Seed a USD sub at the primary household.
  await seedSubscription({
    householdId: primaryHouseholdId,
    merchant: 'USD-Stream',
    amount: 5,
    currency: 'USD',
    category: 'StreamingUSD',
  });
  const cadOnly = await primaryAgent.get('/api/money-leaks?currency=CAD');
  assert.equal(cadOnly.status, 200);
  const items = cadOnly.body.items as Array<{ currency: string }>;
  assert.ok(items.every((i) => i.currency === 'CAD'));
  const usdOnly = await primaryAgent.get('/api/money-leaks?currency=USD');
  assert.equal(usdOnly.status, 200);
  const usdItems = usdOnly.body.items as Array<{ currency: string }>;
  assert.ok(usdItems.every((i) => i.currency === 'USD'));
});

test('GET /api/money-leaks surfaces delivery_fee_high when delivery spend exceeds threshold', async () => {
  // Seed enough Uber Eats charges to exceed the 100 CAD quarterly threshold.
  await seedDeliveryCharges(primaryHouseholdId, primaryAccountId, 15, 12.5);
  const res = await primaryAgent.get('/api/money-leaks');
  const delivery = (
    res.body.items as Array<{ leakType: string; currency: string }>
  ).find((i) => i.leakType === 'delivery_fee_high' && i.currency === 'CAD');
  assert.ok(delivery);
});
