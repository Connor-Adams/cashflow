/**
 * Integration tests for /api/subscription-price-changes (issue #441).
 * Covers: list unacknowledged, list all, acknowledge, household isolation.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import request from 'supertest';
import { setupPgTestDb, teardownPgTestDb, type PgTestDb } from './_setup/pgTestDb.js';

let app: import('express').Express;
let primaryAgent: ReturnType<typeof request.agent>;
let otherAgent: ReturnType<typeof request.agent>;
let primarySubId: number;
let priceChangeId: number;
let testDb: PgTestDb;

type Seeded = {
  token: string;
  householdId: number;
  userId: number;
  subId: number;
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
  const sub = await models.Subscription.create({
    householdId: household.id,
    merchantName: 'Netflix',
    normalizedName: 'netflix',
    amount: '17.99',
    currency: 'CAD',
    cadence: 'monthly',
    lastChargeDate: '2026-04-01',
    nextExpectedDate: '2026-05-01',
    status: 'active',
    category: null,
    annualizedCost: '215.88',
    priceChangeDetected: false,
    cancellationUrl: null,
    notes: null,
  });
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24);
  await models.Session.create({
    userId: user.id,
    tokenHash: hashToken(token),
    expiresAt,
  });
  return { token, householdId: household.id, userId: user.id, subId: sub.id };
}

before(async () => {
  process.env.NODE_ENV = 'test';

  testDb = await setupPgTestDb('subscription_price_changes');

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
  primarySubId = primary.subId;
  primaryAgent = request.agent(app);
  primaryAgent.jar.setCookie(`cashflow_session=${primary.token}; Path=/`);

  const other = await seed('Other');
  otherAgent = request.agent(app);
  otherAgent.jar.setCookie(`cashflow_session=${other.token}; Path=/`);

  // Seed an unacknowledged price change for the primary subscription
  const models = await import('../../src/models');
  const pc = await models.SubscriptionPriceChange.create({
    subscriptionId: primarySubId,
    userId: null,
    detectedOn: '2026-05-30',
    previousAmountCents: 1499,
    newAmountCents: 1799,
    pctChange: '0.200',
    currency: 'CAD',
    triggeringTransactionId: null,
    acknowledgedAt: null,
    acknowledgedByUserId: null,
  });
  priceChangeId = pc.id;
});

after(async () => {
  await teardownPgTestDb(testDb);
});

// ── list ─────────────────────────────────────────────────────────────────────

test('GET /api/subscription-price-changes returns unacknowledged changes', async () => {
  const res = await primaryAgent.get('/api/subscription-price-changes');
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.items));
  assert.equal(res.body.items.length, 1);
  const item = res.body.items[0];
  assert.equal(item.subscriptionId, primarySubId);
  assert.equal(item.previousAmountCents, 1499);
  assert.equal(item.newAmountCents, 1799);
  assert.equal(item.pctChange, '0.200');
  assert.equal(item.acknowledgedAt, null);
});

test('GET /api/subscription-price-changes?status=all returns all changes', async () => {
  const res = await primaryAgent.get('/api/subscription-price-changes?status=all');
  assert.equal(res.status, 200);
  assert.ok(res.body.items.length >= 1);
});

test('GET /api/subscription-price-changes returns empty for other household', async () => {
  const res = await otherAgent.get('/api/subscription-price-changes');
  assert.equal(res.status, 200);
  assert.equal(res.body.items.length, 0);
});

// ── acknowledge ──────────────────────────────────────────────────────────────

test('POST /api/subscription-price-changes/:id/acknowledge marks acknowledged', async () => {
  const res = await primaryAgent
    .post(`/api/subscription-price-changes/${priceChangeId}/acknowledge`)
    .send({});
  assert.equal(res.status, 200);
  assert.ok(res.body.acknowledgedAt);
});

test('GET after acknowledge returns zero unack', async () => {
  const res = await primaryAgent.get('/api/subscription-price-changes');
  assert.equal(res.status, 200);
  assert.equal(res.body.items.length, 0);
});

test('GET ?status=all still shows acknowledged change', async () => {
  const res = await primaryAgent.get('/api/subscription-price-changes?status=all');
  assert.equal(res.status, 200);
  assert.equal(res.body.items.length, 1);
  assert.ok(res.body.items[0].acknowledgedAt);
});

test('Other household cannot acknowledge primary change', async () => {
  const res = await otherAgent
    .post(`/api/subscription-price-changes/${priceChangeId}/acknowledge`)
    .send({});
  assert.equal(res.status, 403);
});

test('GET /api/subscriptions includes pendingPriceChange=null after ack', async () => {
  const res = await primaryAgent.get('/api/subscriptions?refresh=0');
  assert.equal(res.status, 200);
  const sub = res.body.items.find((s: { id: number }) => s.id === primarySubId);
  assert.ok(sub);
  assert.equal(sub.pendingPriceChange, null);
});
