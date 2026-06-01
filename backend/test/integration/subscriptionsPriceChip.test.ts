/**
 * Integration test for the /api/subscriptions price-increase chip
 * (subscription-price-increase Observation, Task 6). Run in isolation
 * (`yarn test:integration`) so DATABASE_URL is set before any Sequelize
 * import.
 *
 * The chip's `pendingPriceChange` is now derived from an OPEN
 * `subscription_price_increase` Insight (entityId = the subscription's
 * PlannedEvent id), NOT the retired `subscription_price_changes` table.
 * Dismissing/resolving the Insight clears the chip on the next read, and the
 * DTO's `priceChangeDetected` boolean is true exactly when an open Insight
 * exists.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import request from 'supertest';
import { setupPgTestDb, teardownPgTestDb, type PgTestDb } from './_setup/pgTestDb.js';

let app: import('express').Express;
let primaryAgent: ReturnType<typeof request.agent>;
let primaryHouseholdId: number;
let testDb: PgTestDb;

type Seeded = {
  token: string;
  householdId: number;
  userId: number;
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
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24);
  await models.Session.create({
    userId: user.id,
    tokenHash: hashToken(token),
    expiresAt,
  });
  return { token, householdId: household.id, userId: user.id };
}

async function seedSubscription(args: {
  householdId: number;
  merchant: string;
  amount: number;
}): Promise<number> {
  const models = await import('../../src/models');
  const lastChargeDate = new Date().toISOString().slice(0, 10);
  const owner = (
    await models.HouseholdMember.findOne({
      where: { householdId: args.householdId, role: 'owner' },
      attributes: ['userId'],
      raw: true,
    })
  )!.userId;
  const pe = await models.PlannedEvent.create({
    kind: 'subscription',
    type: 'expense',
    source: 'recurring_detection',
    userId: owner,
    householdId: args.householdId,
    name: args.merchant,
    normalizedName: args.merchant.toLowerCase(),
    amount: args.amount.toFixed(4),
    currency: 'CAD',
    cadence: 'monthly',
    lastChargeDate,
    nextExpectedDate: null,
    expectedDate: lastChargeDate,
    category: 'Streaming',
    annualizedCost: (args.amount * 12).toFixed(4),
    cancellationUrl: null,
    notes: null,
    status: 'planned',
    statusUncertain: false,
  });
  return pe.id;
}

async function seedPriceIncreaseInsight(args: {
  householdId: number;
  entityId: number;
  prevCents: number;
  newCents: number;
  pctChange: number;
  detectedAt?: Date;
}): Promise<number> {
  const models = await import('../../src/models');
  const ins = await models.Insight.create({
    householdId: args.householdId,
    userId: null,
    type: 'subscription_price_increase',
    severity: 'warning',
    title: 'price increased',
    description: '',
    entityType: 'expectation',
    entityId: args.entityId,
    status: 'open',
    fingerprint: `subscription_price_increase:${args.entityId}:${args.newCents}`,
    metadata: {
      previousAmountCents: args.prevCents,
      newAmountCents: args.newCents,
      pctChange: args.pctChange,
    },
    detectedAt: args.detectedAt ?? new Date(),
  });
  return ins.id;
}

before(async () => {
  testDb = await setupPgTestDb('subscriptions-price-chip');

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
  primaryAgent = request.agent(app);
  primaryAgent.jar.setCookie(`cashflow_session=${primary.token}; Path=/`);
});

after(async () => {
  await teardownPgTestDb(testDb);
});

test('GET /api/subscriptions derives pendingPriceChange from an open Insight', async () => {
  const subId = await seedSubscription({
    householdId: primaryHouseholdId,
    merchant: 'Netflix',
    amount: 11.0,
  });
  const detectedAt = new Date('2026-05-20T12:00:00Z');
  const insightId = await seedPriceIncreaseInsight({
    householdId: primaryHouseholdId,
    entityId: subId,
    prevCents: 1000,
    newCents: 1100,
    pctChange: 10,
    detectedAt,
  });

  // refresh=0: do not re-run recurring detection (no txns seeded), so the
  // hand-seeded subscription row + Insight are read back untouched.
  const res = await primaryAgent.get('/api/subscriptions?refresh=0');
  assert.equal(res.status, 200);
  const items = res.body.items as Array<{
    id: number;
    normalizedName: string;
    priceChangeDetected: boolean;
    pendingPriceChange: {
      id: number;
      prevCents: number;
      newCents: number;
      pctChange: string;
      detectedOn: string;
    } | null;
  }>;
  const netflix = items.find((i) => i.normalizedName === 'netflix');
  assert.ok(netflix, 'expected the seeded Netflix subscription');
  assert.ok(netflix!.pendingPriceChange, 'expected a pendingPriceChange chip');
  assert.equal(netflix!.pendingPriceChange!.id, insightId);
  assert.equal(netflix!.pendingPriceChange!.prevCents, 1000);
  assert.equal(netflix!.pendingPriceChange!.newCents, 1100);
  assert.equal(netflix!.pendingPriceChange!.pctChange, '10');
  assert.equal(netflix!.pendingPriceChange!.detectedOn, '2026-05-20');
  // The DTO boolean is accurate: true exactly when an open Insight exists.
  assert.equal(netflix!.priceChangeDetected, true);
});

test('GET /api/subscriptions: a sub with no open Insight has pendingPriceChange null and priceChangeDetected false', async () => {
  await seedSubscription({
    householdId: primaryHouseholdId,
    merchant: 'Spotify',
    amount: 9.99,
  });
  const res = await primaryAgent.get('/api/subscriptions?refresh=0');
  const spotify = (
    res.body.items as Array<{
      normalizedName: string;
      priceChangeDetected: boolean;
      pendingPriceChange: unknown;
    }>
  ).find((i) => i.normalizedName === 'spotify');
  assert.ok(spotify);
  assert.equal(spotify!.pendingPriceChange, null);
  assert.equal(spotify!.priceChangeDetected, false);
});

test('GET /api/subscriptions: dismissing the Insight clears the chip', async () => {
  const res0 = await primaryAgent.get('/api/subscriptions?refresh=0');
  const netflix0 = (
    res0.body.items as Array<{
      normalizedName: string;
      pendingPriceChange: { id: number } | null;
    }>
  ).find((i) => i.normalizedName === 'netflix');
  assert.ok(netflix0?.pendingPriceChange, 'precondition: Netflix has a chip');
  const insightId = netflix0!.pendingPriceChange!.id;

  const patched = await primaryAgent
    .patch(`/api/insights/${insightId}`)
    .send({ status: 'dismissed' });
  assert.equal(patched.status, 200);

  const res1 = await primaryAgent.get('/api/subscriptions?refresh=0');
  const netflix1 = (
    res1.body.items as Array<{
      normalizedName: string;
      priceChangeDetected: boolean;
      pendingPriceChange: unknown;
    }>
  ).find((i) => i.normalizedName === 'netflix');
  assert.ok(netflix1);
  assert.equal(netflix1!.pendingPriceChange, null);
  assert.equal(netflix1!.priceChangeDetected, false);
});

test('GET /api/subscriptions/summary counts price-increase from open Insights', async () => {
  // Netflix's Insight was dismissed above; Spotify has none. Seed a fresh
  // open Insight for Spotify so the summary count reflects exactly one.
  const list = await primaryAgent.get('/api/subscriptions?refresh=0');
  const spotify = (
    list.body.items as Array<{ id: number; normalizedName: string }>
  ).find((i) => i.normalizedName === 'spotify');
  assert.ok(spotify);
  await seedPriceIncreaseInsight({
    householdId: primaryHouseholdId,
    entityId: spotify!.id,
    prevCents: 999,
    newCents: 1199,
    pctChange: 20,
  });

  const res = await primaryAgent.get('/api/subscriptions/summary?refresh=0');
  assert.equal(res.status, 200);
  const totals = res.body.totals as { priceChangeDetected: number };
  assert.equal(totals.priceChangeDetected, 1);
});
