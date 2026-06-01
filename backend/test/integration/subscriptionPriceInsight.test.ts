/**
 * End-to-end integration test for the subscription price-increase → Insight
 * flow (Task 10 of the subscription-price-increase-observation plan). Run in
 * isolation (`yarn test:integration`, Postgres) so DATABASE_URL is set before
 * any Sequelize import — and because the detector filters
 * `Transaction.merchantClean` with `Op.iLike`, which Sequelize emits as raw
 * `ILIKE` (unsupported by SQLite: `SQLITE_ERROR: near "ILIKE"`).
 *
 * This is the full vertical slice that ties the prior tasks together:
 *   1. Seed a kind='subscription' PlannedEvent + 90d of Transactions with a
 *      >=5% median increase, matched on merchantClean.
 *   2. Run the real detectSubscriptionPriceChanges() — it upserts ONE
 *      subscription_price_increase Insight (Task 3).
 *   3. GET /api/insights?type=subscription_price_increase surfaces it, open,
 *      entityType='expectation', entityId=the sub id, metadata cents correct
 *      (Tasks 1 + 7).
 *   4. GET /api/subscriptions exposes the derived `pendingPriceChange` chip and
 *      priceChangeDetected===true (Task 6).
 *   5. GET /api/money-leaks surfaces a subscription_price_increase leak for the
 *      sub (Task 5).
 *   6. PATCH /api/insights/:id {status:'dismissed'} clears BOTH the chip and the
 *      money-leak (both read status:'open').
 *   7. Re-running the detector does NOT reopen the dismissed Insight — the
 *      status-preserving upsert keeps it dismissed and the count at 1 (Task 2).
 *
 * Mirrors the harness in moneyLeaks.test.ts / subscriptionsPriceChip.test.ts /
 * detectSubscriptionPriceChanges.test.ts: setupPgTestDb, a superadmin bootstrap
 * to satisfy the registration guard, then a non-superadmin household + owner +
 * session agent.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import request from 'supertest';
import { setupPgTestDb, teardownPgTestDb, type PgTestDb } from './_setup/pgTestDb.js';

let app: import('express').Express;
let agent: ReturnType<typeof request.agent>;
let householdId: number;
let ownerUserId: number;
let accountId: number;
let subId: number;
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

/**
 * Seed a tracked subscription (PlannedEvent kind='subscription', status
 * 'active' = {planned, !uncertain}). $20/mo so its $240/yr annualized cost sits
 * above the $120 small_subscription threshold and it is alone in its category —
 * keeping the money-leak output a clean single subscription_price_increase row.
 */
async function seedSub(merchant: string): Promise<number> {
  const models = await import('../../src/models');
  const lastChargeDate = new Date().toISOString().slice(0, 10);
  const row = await models.PlannedEvent.create({
    kind: 'subscription',
    type: 'expense',
    source: 'recurring_detection',
    userId: ownerUserId,
    householdId,
    name: merchant,
    normalizedName: merchant.toLowerCase(),
    amount: '20.0000',
    currency: 'CAD',
    cadence: 'monthly',
    lastChargeDate,
    nextExpectedDate: null,
    // expectedDate (NOT NULL) = nextExpectedDate ?? lastChargeDate.
    expectedDate: lastChargeDate,
    annualizedCost: '240.0000',
    status: 'planned',
    statusUncertain: false,
    category: 'Streaming',
    cancellationUrl: null,
    notes: null,
  });
  return row.id;
}

let fpCounter = 0;
/**
 * Seed one charge `daysAgo` before "now" so all three fixtures land inside the
 * detector's trailing-90-day window regardless of the wall-clock date when the
 * suite runs (the detector compares `date >= now - 90d` and treats the most
 * recent row as the latest charge).
 */
async function seedTxn(merchant: string, amount: string, daysAgo: number): Promise<void> {
  const models = await import('../../src/models');
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - daysAgo);
  const date = d.toISOString().slice(0, 10);
  fpCounter += 1;
  const fp = `spi-${accountId}-${date}-${amount}-${fpCounter}-${Math.random()}`;
  await models.Transaction.create({
    householdId,
    accountId,
    date,
    amount,
    currency: 'CAD',
    merchantRaw: merchant,
    merchantClean: merchant,
    finalCategory: 'Streaming',
    visibility: 'shared',
    importBatch: 'test',
    sourceRowFingerprint: fp,
    sourceIdentityFingerprint: fp,
  } as never);
}

async function runDetector(): Promise<{ detected: number; skipped: number }> {
  const { detectSubscriptionPriceChanges } = await import(
    '../../src/subscriptions/detectSubscriptionPriceChanges'
  );
  return detectSubscriptionPriceChanges();
}

type InsightRow = {
  id: number;
  type: string;
  status: string;
  entityType: string | null;
  entityId: number | null;
  metadata: { previousAmountCents?: number; newAmountCents?: number; pctChange?: number };
};

async function priceInsights(status?: string): Promise<InsightRow[]> {
  const qs = status ? `&status=${status}` : '';
  const res = await agent.get(`/api/insights?type=subscription_price_increase${qs}`);
  assert.equal(res.status, 200);
  return res.body.data as InsightRow[];
}

async function subscriptionRow(): Promise<{
  id: number;
  priceChangeDetected: boolean;
  pendingPriceChange:
    | { id: number; prevCents: number; newCents: number; pctChange: string; detectedOn: string }
    | null;
}> {
  // refresh=0: do not re-run recurring detection (it would reconcile the
  // hand-seeded subscription against the txns and could mutate / re-key the
  // row). We want the seeded PlannedEvent id stable so the Insight's entityId
  // linkage holds; the chip-derivation path runs either way.
  const res = await agent.get('/api/subscriptions?refresh=0');
  assert.equal(res.status, 200);
  const items = res.body.items as Array<{
    id: number;
    priceChangeDetected: boolean;
    pendingPriceChange:
      | { id: number; prevCents: number; newCents: number; pctChange: string; detectedOn: string }
      | null;
  }>;
  const row = items.find((i) => i.id === subId);
  assert.ok(row, 'expected the seeded subscription in /api/subscriptions');
  return row!;
}

async function priceLeaks(): Promise<
  Array<{ leakType: string; identityKey: string; meta?: { subscriptionId?: number } }>
> {
  const res = await agent.get('/api/money-leaks');
  assert.equal(res.status, 200);
  return (res.body.items as Array<{
    leakType: string;
    identityKey: string;
    meta?: { subscriptionId?: number };
  }>).filter((i) => i.leakType === 'subscription_price_increase');
}

before(async () => {
  testDb = await setupPgTestDb('subscription-price-insight');

  const mod = await import('../../src/app.js');
  app = mod.default;

  // First registration becomes the global superadmin and opens the gate.
  const bootstrap = request.agent(app);
  const register = await bootstrap.post('/api/auth/register').send({
    email: 'superadmin@example.com',
    displayName: 'Super Admin',
    password: 'password123',
  });
  assert.equal(register.status, 201);

  const primary = await seed('Primary');
  householdId = primary.householdId;
  ownerUserId = primary.userId;
  accountId = primary.accountId;
  agent = request.agent(app);
  agent.jar.setCookie(`cashflow_session=${primary.token}; Path=/`);

  // Seed the subscription + 90d of charges with a >=5% median increase:
  // priors median = $10, latest = $11 → +10%.
  subId = await seedSub('Netflix');
  await seedTxn('Netflix', '-10.00', 60);
  await seedTxn('Netflix', '-10.00', 30);
  await seedTxn('Netflix', '-11.00', 0);
});

after(async () => {
  await teardownPgTestDb(testDb);
});

test('detectSubscriptionPriceChanges emits exactly one open Insight surfaced by GET /api/insights', async () => {
  const r = await runDetector();
  assert.equal(r.detected, 1);

  const insights = await priceInsights();
  assert.equal(insights.length, 1);
  const ins = insights[0];
  assert.equal(ins.status, 'open');
  assert.equal(ins.entityType, 'expectation');
  assert.equal(ins.entityId, subId);
  assert.equal(ins.metadata.newAmountCents, 1100);
  assert.equal(ins.metadata.previousAmountCents, 1000);
  assert.equal(ins.metadata.pctChange, 10);
});

test('GET /api/subscriptions exposes the derived pendingPriceChange chip', async () => {
  const sub = await subscriptionRow();
  assert.equal(sub.priceChangeDetected, true);
  assert.ok(sub.pendingPriceChange, 'expected a pendingPriceChange chip');
  assert.equal(sub.pendingPriceChange!.prevCents, 1000);
  assert.equal(sub.pendingPriceChange!.newCents, 1100);
  assert.equal(sub.pendingPriceChange!.pctChange, '10');
});

test('GET /api/money-leaks surfaces a subscription_price_increase leak for the sub', async () => {
  const leaks = await priceLeaks();
  assert.equal(leaks.length, 1);
  assert.equal(leaks[0].identityKey, String(subId));
  assert.equal(leaks[0].meta?.subscriptionId, subId);
});

test('PATCH /api/insights/:id {dismissed} clears both the chip and the money-leak', async () => {
  const open = await priceInsights('open');
  assert.equal(open.length, 1);
  const insightId = open[0].id;

  const patched = await agent
    .patch(`/api/insights/${insightId}`)
    .send({ status: 'dismissed' });
  assert.equal(patched.status, 200);
  assert.equal(patched.body.status, 'dismissed');

  // Chip clears (route reads status:'open').
  const sub = await subscriptionRow();
  assert.equal(sub.pendingPriceChange, null);
  assert.equal(sub.priceChangeDetected, false);

  // Money-leak clears (route reads status:'open').
  const leaks = await priceLeaks();
  assert.equal(leaks.length, 0);

  // The Insight still exists — just dismissed.
  const all = await priceInsights();
  assert.equal(all.length, 1);
  assert.equal(all[0].status, 'dismissed');
});

test('re-running the detector does NOT reopen the dismissed Insight', async () => {
  const r = await runDetector();
  // The detector still "detects" the increase; the status-preserving upsert
  // refreshes the row in place rather than reopening it.
  assert.equal(r.detected, 1);

  const all = await priceInsights();
  assert.equal(all.length, 1, 'must not create a duplicate Insight');
  assert.equal(all[0].status, 'dismissed', 'dismissed Insight must stay dismissed');

  // And the consumers stay clear.
  const sub = await subscriptionRow();
  assert.equal(sub.pendingPriceChange, null);
  assert.equal(sub.priceChangeDetected, false);
  const leaks = await priceLeaks();
  assert.equal(leaks.length, 0);
});
