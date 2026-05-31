/**
 * Integration coverage for the Expectation merge (Task 5): after the fold,
 * planned_events holds BOTH one-shot planned events (kind='planned') and
 * subscriptions (kind='subscription'). Every reader that historically saw only
 * planned events MUST filter kind='planned', or subscriptions leak into the
 * forecast / calendar / planned-events list / etc.
 *
 * This test seeds one row of each kind and asserts the planned reader surfaces
 * (the /api/planned-events list and /api/forecast) show the planned row and do
 * NOT show the subscription row.
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
  agent = request.agent(app);
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

test('subscription rows do NOT appear in /api/forecast', async () => {
  const res = await agent.get('/api/forecast');
  assert.equal(res.status, 200);
  const body = JSON.stringify(res.body);
  assert.ok(!body.includes('Netflix'), 'subscription leaked into /api/forecast');
});
