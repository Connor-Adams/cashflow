/**
 * Integration coverage for the Expectation merge (Task 6): the fold must
 * preserve the pre-fold HTTP contract. The /api/subscriptions/summary and
 * /api/money-leaks endpoints now read the merged PlannedEvent model
 * (kind='subscription') instead of the legacy subscriptions table, but their
 * response shapes must be byte-for-byte compatible with what the frontend
 * expects.
 *
 * Postgres-only (exercises the merged model against the real DB), so it runs
 * under `yarn test:integration` in CI.
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
  testDb = await setupPgTestDb('expectation_parity');
  const mod = await import('../../src/app.js');
  app = mod.default;
  const models = await import('../../src/models');
  const { hashPassword, hashToken } = await import('../../src/auth/password.js');
  const pw = await hashPassword('password123');
  const user = await models.User.create({
    email: `parity-${Date.now()}@example.com`,
    displayName: 'Parity',
    globalRole: 'user',
    passwordHash: pw.hash,
    passwordSalt: pw.salt,
    passwordParams: pw.params,
  });
  const household = await models.Household.create({ name: 'Parity household' });
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

  // Seed one subscription as a merged Expectation row so both endpoints have
  // a row to fold through serializeSubscription. status='planned' +
  // statusUncertain=false serializes to the legacy 'active'.
  await models.PlannedEvent.create({
    householdId,
    userId,
    kind: 'subscription',
    type: 'expense',
    source: 'recurring_detection',
    name: 'Netflix',
    normalizedName: 'netflix',
    cadence: 'monthly',
    expectedDate: '2026-06-15',
    lastChargeDate: '2026-05-15',
    annualizedCost: '240.0000',
    status: 'planned',
    statusUncertain: false,
    category: 'Streaming',
    priceChangeDetected: false,
    currency: 'CAD',
  });
});

after(async () => {
  await teardownPgTestDb(testDb);
});

test('GET /api/subscriptions/summary keeps legacy totals shape', async () => {
  // refresh=0 so the detector (no transactions seeded) doesn't run and mutate
  // the seeded row.
  const res = await agent.get('/api/subscriptions/summary?refresh=0');
  assert.equal(res.status, 200);
  assert.ok(res.body.totals);
  assert.equal(typeof res.body.totals.active, 'number');
  assert.equal(typeof res.body.totals.cancelled, 'number');
  assert.equal(typeof res.body.totals.unknown, 'number');
  assert.ok(Array.isArray(res.body.byCurrency));
});

test('GET /api/money-leaks still returns items + totals.byCurrency', async () => {
  const res = await agent.get('/api/money-leaks');
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.items));
  assert.ok(res.body.totals);
  assert.ok(Array.isArray(res.body.totals.byCurrency));
});
