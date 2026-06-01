/**
 * Integration coverage for the Expectation merge (Task 3): /api/subscriptions
 * reads and writes the merged PlannedEvent model (rows with kind='subscription')
 * and serializes them back to the legacy Subscription DTO, so the frontend is
 * unchanged.
 *
 * Postgres-only (the merged model + partial unique index are exercised against
 * the real DB), so it runs under `yarn test:integration` in CI. The pure status
 * mapping + DTO serialization is unit-tested separately in
 * test/subscriptionMapper.test.ts.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import request from 'supertest';
import { setupPgTestDb, teardownPgTestDb, type PgTestDb } from './_setup/pgTestDb.js';

let app: import('express').Express;
let agent: ReturnType<typeof request.agent>;
let householdId: number;
let userId: number;
let testDb: PgTestDb;

before(async () => {
  process.env.NODE_ENV = 'test';
  testDb = await setupPgTestDb('subscriptions_fold');
  const mod = await import('../../src/app.js');
  app = mod.default;
  const models = await import('../../src/models');
  const { hashPassword, hashToken } = await import('../../src/auth/password.js');
  const pw = await hashPassword('password123');
  const user = await models.User.create({
    email: `sub-fold-${Date.now()}@example.com`,
    displayName: 'Fold',
    globalRole: 'user',
    passwordHash: pw.hash,
    passwordSalt: pw.salt,
    passwordParams: pw.params,
  });
  const household = await models.Household.create({ name: 'Fold household' });
  await models.HouseholdMember.create({
    householdId: household.id,
    userId: user.id,
    role: 'owner',
  });
  householdId = household.id;
  userId = user.id;
  const token = crypto.randomBytes(32).toString('hex');
  await models.Session.create({
    userId: user.id,
    tokenHash: hashToken(token),
    expiresAt: new Date(Date.now() + 86400000),
  });
  agent = request.agent(app);
  agent.jar.setCookie(`cashflow_session=${token}; Path=/`);

  // Seed a subscription directly as a merged Expectation row. Merged status
  // 'planned' (+ statusUncertain=false) serializes back to the legacy 'active'.
  await models.PlannedEvent.create({
    householdId,
    userId,
    kind: 'subscription',
    type: 'expense',
    source: 'recurring_detection',
    name: 'Netflix',
    normalizedName: 'netflix',
    amount: '20.0000',
    currency: 'CAD',
    cadence: 'monthly',
    expectedDate: '2026-06-15',
    lastChargeDate: '2026-05-15',
    nextExpectedDate: '2026-06-15',
    annualizedCost: '240.0000',
    status: 'planned',
    statusUncertain: false,
    category: 'Streaming',
  });
});

after(async () => {
  await teardownPgTestDb(testDb);
});

test('GET /api/subscriptions returns the merged row in the legacy DTO shape', async () => {
  // refresh=0 so the detector (which has no transactions to work with here)
  // doesn't run and the seeded row is returned as-is.
  const res = await agent.get('/api/subscriptions?refresh=0');
  assert.equal(res.status, 200);
  assert.equal(Array.isArray(res.body.items), true);
  const sub = res.body.items.find(
    (s: { merchantName: string }) => s.merchantName === 'Netflix',
  );
  assert.ok(sub, 'Netflix present');
  assert.equal(sub.cadence, 'monthly');
  assert.equal(sub.normalizedName, 'netflix');
  assert.equal(sub.status, 'active'); // serializer maps planned -> active
  assert.equal(Number(sub.amount), 20);
  assert.equal(sub.nextExpectedDate, '2026-06-15');
  assert.equal(sub.lastChargeDate, '2026-05-15');
  assert.equal(Number(sub.annualizedCost), 240);
  assert.equal(sub.category, 'Streaming');
  assert.equal(sub.priceChangeDetected, false);
  assert.equal(sub.cancellationUrl, null);
  // Merged-model-only fields must not leak into the legacy DTO.
  assert.equal('name' in sub, false);
  assert.equal('statusUncertain' in sub, false);
  assert.equal('kind' in sub, false);
});

test('PATCH /api/subscriptions/:id?status=cancelled persists as cancelled', async () => {
  const list = await agent.get('/api/subscriptions?refresh=0');
  const id = list.body.items[0].id;
  const res = await agent
    .patch(`/api/subscriptions/${id}`)
    .send({ status: 'cancelled' });
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'cancelled');

  // And it survives a re-read (persisted as merged status='cancelled').
  const after = await agent.get('/api/subscriptions?refresh=0');
  const sub = after.body.items.find((s: { id: number }) => s.id === id);
  assert.ok(sub);
  assert.equal(sub.status, 'cancelled');
});

test('the merged row is stored with kind=subscription, not in the subscriptions table', async () => {
  const models = await import('../../src/models');
  const merged = await models.PlannedEvent.findOne({
    where: { householdId, kind: 'subscription', normalizedName: 'netflix' },
  });
  assert.ok(merged, 'row lives in planned_events with kind=subscription');
  // Write path persisted the merged status machine, not the legacy string.
  assert.equal(merged!.status, 'cancelled');
  assert.equal(merged!.statusUncertain, false);
  assert.equal(merged!.type, 'expense');
});
