/**
 * Integration coverage for the Expectation merge (Task 5): after the fold,
 * planned_events holds BOTH one-shot planned events (kind='planned') and
 * subscriptions (kind='subscription').
 *
 * The planned-events LIST view (/api/planned-events) is a distinct surface from
 * subscriptions and MUST filter kind='planned' — subscriptions have their own
 * view, so they must not leak into the planned-events list.
 *
 * The FORECAST is different: it is a projection of all future cash movement, so
 * recurring subscription expenses legitimately belong there as projected
 * outflows. (Excluding them was a bug — the forecast was blind to tracked
 * subscriptions.) This test pins both rules: subscriptions stay OUT of the
 * planned-events list but DO appear in the forecast.
 *
 * Postgres-only (exercises the merged model against the real DB), so it runs
 * under `yarn test:integration` in CI.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import request from 'supertest';
import { testAgent } from './_setup/testServer.js';
import { setupPgTestDb, teardownPgTestDb, type PgTestDb } from './_setup/pgTestDb.js';

let app: import('express').Express;
let agent: ReturnType<typeof request.agent>;
let householdId: number;
let userId: number;
let testDb: PgTestDb;

before(async () => {
  process.env.NODE_ENV = 'test';
  testDb = await setupPgTestDb('expectation_kind_isolation');
  const mod = await import('../../src/app.js');
  app = mod.default;
  const models = await import('../../src/models');
  const { hashPassword, hashToken } = await import('../../src/auth/password.js');
  const pw = await hashPassword('password123');
  const user = await models.User.create({
    email: `kind-iso-${Date.now()}@example.com`,
    displayName: 'KindIso',
    globalRole: 'user',
    passwordHash: pw.hash,
    passwordSalt: pw.salt,
    passwordParams: pw.params,
  });
  const household = await models.Household.create({ name: 'KindIso household' });
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
  agent = testAgent(app);
  agent.jar.setCookie(`cashflow_session=${token}; Path=/`);

  // One genuine planned event (kind='planned').
  await models.PlannedEvent.create({
    householdId,
    userId,
    kind: 'planned',
    type: 'expense',
    name: 'PlannedRent',
    expectedDate: '2026-06-20',
    amount: '100.0000',
    currency: 'CAD',
    status: 'planned',
  });

  // One subscription, stored in the same table as kind='subscription'.
  await models.PlannedEvent.create({
    householdId,
    userId,
    kind: 'subscription',
    type: 'expense',
    source: 'recurring_detection',
    name: 'Netflix',
    normalizedName: 'netflix',
    amount: '15.9900',
    cadence: 'monthly',
    expectedDate: '2026-06-15',
    lastChargeDate: '2026-05-15',
    annualizedCost: '240.0000',
    status: 'planned',
    currency: 'CAD',
  });
});

after(async () => {
  await teardownPgTestDb(testDb);
});

test('subscription rows do NOT appear in /api/planned-events', async () => {
  const res = await agent.get('/api/planned-events');
  assert.equal(res.status, 200);
  const names = res.body.data.map((p: { name: string }) => p.name);
  assert.ok(names.includes('PlannedRent'), 'planned event present');
  assert.ok(
    !names.includes('Netflix'),
    'subscription leaked into /api/planned-events',
  );
});

test('subscription rows DO appear in /api/forecast as projected outflows', async () => {
  // Window covering the subscription's seed date (2026-06-15, monthly cadence).
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
  const netflix = events.filter((e) => e.sourceName === 'Netflix');
  assert.equal(netflix.length, 1, 'subscription should be projected into the forecast');
  assert.equal(netflix[0].direction, 'out');
  assert.equal(netflix[0].date, '2026-06-15');
  assert.equal(netflix[0].amount, 15.99);
});
