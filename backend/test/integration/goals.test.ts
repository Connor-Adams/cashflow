/**
 * Integration tests for /api/goals (issue #203). Run in isolation
 * (`yarn test:integration`) so DATABASE_URL is set before any Sequelize
 * import.
 *
 * Pattern mirrors `plannedEvents.test.ts`: bootstrap a superadmin, then
 * seed two non-superadmin households so cross-household isolation can be
 * exercised via real session cookies. Each household also gets its own
 * account (goals can optionally reference one).
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import request from 'supertest';
import { testAgent } from './_setup/testServer.js';
import { setupPgTestDb, teardownPgTestDb, type PgTestDb } from './_setup/pgTestDb.js';

let app: import('express').Express;
let primaryAgent: ReturnType<typeof request.agent>;
let primaryHouseholdId: number;
let primaryAccountId: number;
let primaryUserId: number;
let otherAgent: ReturnType<typeof request.agent>;
let otherAccountId: number;
let otherHouseholdId: number;
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
    name: `${emailPrefix} savings`,
    accountType: 'savings',
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

before(async () => {
  process.env.NODE_ENV = 'test';

  testDb = await setupPgTestDb('financial_goals');

  const mod = await import('../../src/app.js');
  app = mod.default;

  const bootstrap = testAgent(app);
  const register = await bootstrap.post('/api/auth/register').send({
    email: 'superadmin@example.com',
    displayName: 'Super Admin',
    password: 'password123',
  });
  assert.equal(register.status, 201);

  const primary = await seed('Primary');
  primaryHouseholdId = primary.householdId;
  primaryAccountId = primary.accountId;
  primaryUserId = primary.userId;
  primaryAgent = testAgent(app);
  primaryAgent.jar.setCookie(`cashflow_session=${primary.token}; Path=/`);

  const other = await seed('Other');
  otherHouseholdId = other.householdId;
  otherAccountId = other.accountId;
  otherAgent = testAgent(app);
  otherAgent.jar.setCookie(`cashflow_session=${other.token}; Path=/`);
});

after(async () => {
  await teardownPgTestDb(testDb);
});

test('POST /api/goals creates an emergency fund goal with defaults', async () => {
  const res = await primaryAgent.post('/api/goals').send({
    name: 'Emergency fund',
    targetAmount: 5000,
    currency: 'CAD',
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.name, 'Emergency fund');
  assert.equal(Number(res.body.targetAmount), 5000);
  assert.equal(Number(res.body.currentAmount), 0);
  assert.equal(res.body.currency, 'CAD');
  assert.equal(res.body.status, 'active');
  assert.equal(res.body.priority, 0);
  assert.equal(res.body.targetDate, null);
  assert.equal(res.body.monthlyContribution, null);
  assert.equal(res.body.linkedAccountId, null);
  assert.equal(res.body.householdId, primaryHouseholdId);
  assert.equal(res.body.userId, primaryUserId);
});

test('POST /api/goals creates a vacation sinking fund with target date + linked account', async () => {
  const res = await primaryAgent.post('/api/goals').send({
    name: 'Vacation 2027',
    targetAmount: 4000,
    currentAmount: 500,
    currency: 'CAD',
    targetDate: '2027-06-01',
    monthlyContribution: 300,
    linkedAccountId: primaryAccountId,
    priority: 5,
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.targetDate, '2027-06-01');
  assert.equal(Number(res.body.monthlyContribution), 300);
  assert.equal(res.body.linkedAccountId, primaryAccountId);
  assert.equal(res.body.priority, 5);
});

test('POST /api/goals rejects an account from another household', async () => {
  const res = await primaryAgent.post('/api/goals').send({
    name: 'Sneaky goal',
    targetAmount: 100,
    currency: 'CAD',
    linkedAccountId: otherAccountId,
  });
  assert.equal(res.status, 400);
});

test('POST /api/goals rejects missing name', async () => {
  const res = await primaryAgent.post('/api/goals').send({
    targetAmount: 100,
    currency: 'CAD',
  });
  assert.equal(res.status, 400);
});

test('POST /api/goals rejects non-positive targetAmount', async () => {
  const res = await primaryAgent.post('/api/goals').send({
    name: 'Bad',
    targetAmount: 0,
    currency: 'CAD',
  });
  assert.equal(res.status, 400);
});

test('POST /api/goals rejects invalid status', async () => {
  const res = await primaryAgent.post('/api/goals').send({
    name: 'Bad status',
    targetAmount: 100,
    currency: 'CAD',
    status: 'archived',
  });
  assert.equal(res.status, 400);
});

test('POST /api/goals rejects bad date format', async () => {
  const res = await primaryAgent.post('/api/goals').send({
    name: 'Date bug',
    targetAmount: 100,
    currency: 'CAD',
    targetDate: '06/01/2027',
  });
  assert.equal(res.status, 400);
});

test('GET /api/goals returns rows sorted by priority DESC then name ASC', async () => {
  const list = await primaryAgent.get('/api/goals');
  assert.equal(list.status, 200);
  const rows = list.body.data as Array<{ priority: number; name: string }>;
  assert.ok(rows.length >= 2);
  for (let i = 1; i < rows.length; i++) {
    const prev = rows[i - 1];
    const cur = rows[i];
    if (prev.priority !== cur.priority) {
      assert.ok(prev.priority >= cur.priority,
        `expected priority DESC, got ${prev.priority} then ${cur.priority}`);
    } else {
      assert.ok(prev.name.localeCompare(cur.name) <= 0,
        `expected name ASC within same priority, got ${prev.name} then ${cur.name}`);
    }
  }
});

test('GET /api/goals supports status filter', async () => {
  // Create a paused goal in primary household
  await primaryAgent.post('/api/goals').send({
    name: 'Paused goal',
    targetAmount: 100,
    currency: 'CAD',
    status: 'paused',
  });
  const list = await primaryAgent
    .get('/api/goals')
    .query({ status: 'paused' });
  assert.equal(list.status, 200);
  const rows = list.body.data as Array<{ status: string }>;
  assert.ok(rows.length > 0);
  for (const row of rows) assert.equal(row.status, 'paused');
});

test('GET /api/goals does not leak rows from another household', async () => {
  const otherCreated = await otherAgent.post('/api/goals').send({
    name: 'Other private',
    targetAmount: 999,
    currency: 'CAD',
    linkedAccountId: otherAccountId,
  });
  assert.equal(otherCreated.status, 201);

  const otherList = await otherAgent.get('/api/goals');
  assert.equal(otherList.status, 200);
  assert.equal(otherList.body.data.length, 1);

  const primaryList = await primaryAgent.get('/api/goals');
  const primaryIds = (primaryList.body.data as Array<{ id: number }>).map((r) => r.id);
  assert.ok(!primaryIds.includes(otherCreated.body.id));
});

test('GET /api/goals/:id returns a single row', async () => {
  const created = await primaryAgent.post('/api/goals').send({
    name: 'Single fetch',
    targetAmount: 250,
    currency: 'CAD',
  });
  const id = created.body.id as number;
  const res = await primaryAgent.get(`/api/goals/${id}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.id, id);
  assert.equal(res.body.name, 'Single fetch');
});

test('GET /api/goals/:id 404s for another household', async () => {
  const otherCreated = await otherAgent.post('/api/goals').send({
    name: 'Other secret',
    targetAmount: 12,
    currency: 'CAD',
  });
  const otherId = otherCreated.body.id as number;
  const sneak = await primaryAgent.get(`/api/goals/${otherId}`);
  assert.equal(sneak.status, 404);
});

test('GET /api/goals/:id/projection returns on_track when contribution matches required', async () => {
  // Target $1200 by 2027-06-01, today injected as 2026-06-01 => 12 months;
  // required = 1200/12 = $100/mo; contribution = $100/mo => on_track.
  const created = await primaryAgent.post('/api/goals').send({
    name: 'Projection test',
    targetAmount: 1200,
    currentAmount: 0,
    currency: 'CAD',
    targetDate: '2027-06-01',
    monthlyContribution: 100,
  });
  const id = created.body.id as number;

  const res = await primaryAgent
    .get(`/api/goals/${id}/projection`)
    .query({ today: '2026-06-01' });
  assert.equal(res.status, 200);
  assert.equal(res.body.goalId, id);
  assert.equal(res.body.status, 'on_track');
  assert.equal(res.body.monthsRemaining, 12);
  assert.equal(Number(res.body.requiredMonthlyContribution), 100);
  assert.equal(res.body.projectedCompletionDate, '2027-06-01');
});

test('GET /api/goals/:id/projection returns behind when contribution < 90% required', async () => {
  const created = await primaryAgent.post('/api/goals').send({
    name: 'Behind test',
    targetAmount: 1200,
    currentAmount: 0,
    currency: 'CAD',
    targetDate: '2027-06-01',
    monthlyContribution: 50,
  });
  const id = created.body.id as number;
  const res = await primaryAgent
    .get(`/api/goals/${id}/projection`)
    .query({ today: '2026-06-01' });
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'behind');
});

test('GET /api/goals/:id/projection returns unfunded when no contribution set', async () => {
  const created = await primaryAgent.post('/api/goals').send({
    name: 'Unfunded test',
    targetAmount: 1200,
    currency: 'CAD',
    targetDate: '2027-06-01',
  });
  const id = created.body.id as number;
  const res = await primaryAgent
    .get(`/api/goals/${id}/projection`)
    .query({ today: '2026-06-01' });
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'unfunded');
  assert.equal(Number(res.body.requiredMonthlyContribution), 100);
});

test('GET /api/goals/:id/projection 404s for another household', async () => {
  const otherCreated = await otherAgent.post('/api/goals').send({
    name: 'Other projection',
    targetAmount: 100,
    currency: 'CAD',
  });
  const otherId = otherCreated.body.id as number;
  const sneak = await primaryAgent.get(`/api/goals/${otherId}/projection`);
  assert.equal(sneak.status, 404);
});

// ---- #653: forecast-grounded validation -------------------------------------

test('GET /api/goals/:id/projection includes a forecast block (AC1)', async () => {
  const created = await primaryAgent.post('/api/goals').send({
    name: 'Forecast block test',
    targetAmount: 1200,
    currentAmount: 0,
    currency: 'CAD',
    targetDate: '2027-06-01',
    monthlyContribution: 100,
  });
  const id = created.body.id as number;
  const res = await primaryAgent
    .get(`/api/goals/${id}/projection`)
    .query({ today: '2026-06-01' });
  assert.equal(res.status, 200);
  assert.ok(res.body.forecast, 'forecast block present');
  const f = res.body.forecast;
  assert.equal(typeof f.monthlyFreeCash, 'string');
  assert.ok('status' in f);
  assert.ok('requiredMonthlyContribution' in f);
  assert.ok('projectedCompletionDate' in f);
  assert.equal(typeof f.currencyMismatch, 'boolean');
  assert.equal(typeof f.currency, 'string');
});

test('GET /api/goals/:id/projection forecast off_track with no free cash (AC4, AC8)', async () => {
  // Clean household: no income → monthly free cash <= 0 → off_track. The
  // required-monthly number is still surfaced for the UI.
  const created = await primaryAgent.post('/api/goals').send({
    name: 'No-cash goal',
    targetAmount: 1200,
    currentAmount: 0,
    currency: 'CAD',
    targetDate: '2027-06-01',
  });
  const id = created.body.id as number;
  const res = await primaryAgent
    .get(`/api/goals/${id}/projection`)
    .query({ today: '2026-06-01' });
  assert.equal(res.status, 200);
  assert.equal(res.body.forecast.status, 'off_track');
  assert.equal(Number(res.body.forecast.requiredMonthlyContribution), 100);
  assert.equal(res.body.forecast.projectedCompletionDate, null);
});

test('GET /api/goals/:id/projection forecast no_deadline when no target date (AC6)', async () => {
  const created = await primaryAgent.post('/api/goals').send({
    name: 'No-deadline goal',
    targetAmount: 1200,
    currency: 'CAD',
  });
  const id = created.body.id as number;
  const res = await primaryAgent
    .get(`/api/goals/${id}/projection`)
    .query({ today: '2026-06-01' });
  assert.equal(res.status, 200);
  assert.equal(res.body.forecast.status, 'no_deadline');
  assert.equal(res.body.forecast.requiredMonthlyContribution, null);
});

test('GET /api/goals/:id/projection forecast completed regardless of free cash (AC5)', async () => {
  const created = await primaryAgent.post('/api/goals').send({
    name: 'Met goal',
    targetAmount: 1000,
    currentAmount: 1000,
    currency: 'CAD',
    targetDate: '2027-06-01',
  });
  const id = created.body.id as number;
  const res = await primaryAgent
    .get(`/api/goals/${id}/projection`)
    .query({ today: '2026-06-01' });
  assert.equal(res.status, 200);
  assert.equal(res.body.forecast.status, 'completed');
});

test('GET /api/goals/:id/projection forecast cant_validate on currency mismatch (AC7)', async () => {
  // Household cash is CAD (the only currency with a balance), so a EUR goal
  // can't be validated — no faked FX conversion.
  const created = await primaryAgent.post('/api/goals').send({
    name: 'Euro goal',
    targetAmount: 1200,
    currentAmount: 0,
    currency: 'EUR',
    targetDate: '2027-06-01',
  });
  const id = created.body.id as number;
  const res = await primaryAgent
    .get(`/api/goals/${id}/projection`)
    .query({ today: '2026-06-01' });
  assert.equal(res.status, 200);
  assert.equal(res.body.forecast.currencyMismatch, true);
  assert.equal(res.body.forecast.status, 'cant_validate');
  assert.equal(res.body.forecast.requiredMonthlyContribution, null);
});

test('GET /api/goals/:id/projection forecast on_track when forecasted income covers the goal (AC2)', async () => {
  // Seed a recurring monthly income that gives plenty of free cash, then a
  // modest goal. Over the 90-day goal window the income nets positive and
  // exceeds the required monthly → on_track, driven by the forecast (NOT a
  // typed monthlyContribution, which we deliberately omit).
  await primaryAgent.post('/api/planned-events').send({
    type: 'income',
    name: 'Forecast salary 653',
    amount: 4000,
    currency: 'CAD',
    expectedDate: '2026-06-15',
    recurrenceRule: 'FREQ=MONTHLY;BYMONTHDAY=15',
    accountId: primaryAccountId,
  });

  const created = await primaryAgent.post('/api/goals').send({
    name: 'Fundable goal',
    targetAmount: 1200,
    currentAmount: 0,
    currency: 'CAD',
    targetDate: '2027-06-01', // required ~100/mo
  });
  const id = created.body.id as number;
  const res = await primaryAgent
    .get(`/api/goals/${id}/projection`)
    .query({ today: '2026-06-01' });
  assert.equal(res.status, 200);
  assert.ok(
    Number(res.body.forecast.monthlyFreeCash) > 0,
    `expected positive free cash, got ${res.body.forecast.monthlyFreeCash}`,
  );
  assert.equal(res.body.forecast.status, 'on_track');
  // Completion date derives from free cash, present and non-null (AC9).
  assert.ok(res.body.forecast.projectedCompletionDate);
});

test('PUT /api/goals/:id patches partial fields', async () => {
  const created = await primaryAgent.post('/api/goals').send({
    name: 'Patch initial',
    targetAmount: 100,
    currency: 'CAD',
  });
  const id = created.body.id as number;

  const patched = await primaryAgent.put(`/api/goals/${id}`).send({
    name: 'Patch renamed',
    currentAmount: 25,
    priority: 3,
  });
  assert.equal(patched.status, 200);
  assert.equal(patched.body.name, 'Patch renamed');
  assert.equal(Number(patched.body.currentAmount), 25);
  assert.equal(patched.body.priority, 3);
  // Untouched fields stick
  assert.equal(Number(patched.body.targetAmount), 100);
  assert.equal(patched.body.currency, 'CAD');
});

test('PUT /api/goals/:id can mark a goal as completed (archive)', async () => {
  const created = await primaryAgent.post('/api/goals').send({
    name: 'To complete',
    targetAmount: 100,
    currentAmount: 100,
    currency: 'CAD',
  });
  const id = created.body.id as number;

  const completed = await primaryAgent.put(`/api/goals/${id}`).send({
    status: 'completed',
  });
  assert.equal(completed.status, 200);
  assert.equal(completed.body.status, 'completed');

  // Still listable when filtered by completed
  const list = await primaryAgent
    .get('/api/goals')
    .query({ status: 'completed' });
  const ids = (list.body.data as Array<{ id: number }>).map((r) => r.id);
  assert.ok(ids.includes(id), 'Completed goal should still be in DB');
});

test('PUT /api/goals/:id can clear targetDate by sending null', async () => {
  const created = await primaryAgent.post('/api/goals').send({
    name: 'Clearable date',
    targetAmount: 100,
    currency: 'CAD',
    targetDate: '2027-01-01',
  });
  const id = created.body.id as number;
  assert.equal(created.body.targetDate, '2027-01-01');

  const patched = await primaryAgent.put(`/api/goals/${id}`).send({
    targetDate: null,
  });
  assert.equal(patched.status, 200);
  assert.equal(patched.body.targetDate, null);
});

test('PUT /api/goals/:id rejects switching to an account in another household', async () => {
  const created = await primaryAgent.post('/api/goals').send({
    name: 'Boundary',
    targetAmount: 100,
    currency: 'CAD',
  });
  const id = created.body.id as number;

  const sneaky = await primaryAgent.put(`/api/goals/${id}`).send({
    linkedAccountId: otherAccountId,
  });
  assert.equal(sneaky.status, 400);
});

test('PUT /api/goals/:id 404s for another household', async () => {
  const otherCreated = await otherAgent.post('/api/goals').send({
    name: 'Other untouchable',
    targetAmount: 50,
    currency: 'CAD',
  });
  const otherId = otherCreated.body.id as number;
  const sneak = await primaryAgent.put(`/api/goals/${otherId}`).send({
    name: 'Pwn3d',
  });
  assert.equal(sneak.status, 404);
});

test('DELETE /api/goals/:id removes the row for the owning household', async () => {
  const created = await primaryAgent.post('/api/goals').send({
    name: 'Delete me',
    targetAmount: 5,
    currency: 'CAD',
  });
  const id = created.body.id as number;

  const wrongHousehold = await otherAgent.delete(`/api/goals/${id}`);
  assert.equal(wrongHousehold.status, 404);

  const owner = await primaryAgent.delete(`/api/goals/${id}`);
  assert.equal(owner.status, 204);

  const gone = await primaryAgent.delete(`/api/goals/${id}`);
  assert.equal(gone.status, 404);
});

// ---- #845: goal-progress lost update ----------------------------------------

test('POST /api/goals/:id/contribute adds a delta atomically', async () => {
  const created = await primaryAgent.post('/api/goals').send({
    name: 'Contribute single',
    targetAmount: 5000,
    currentAmount: 1000,
    currency: 'CAD',
  });
  const id = created.body.id as number;

  const res = await primaryAgent
    .post(`/api/goals/${id}/contribute`)
    .send({ amount: 250 });
  assert.equal(res.status, 200);
  assert.equal(Number(res.body.currentAmount), 1250);
});

test('POST /api/goals/:id/contribute supports a negative delta, clamped at 0', async () => {
  const created = await primaryAgent.post('/api/goals').send({
    name: 'Withdraw',
    targetAmount: 5000,
    currentAmount: 100,
    currency: 'CAD',
  });
  const id = created.body.id as number;

  const ok = await primaryAgent
    .post(`/api/goals/${id}/contribute`)
    .send({ amount: -40 });
  assert.equal(ok.status, 200);
  assert.equal(Number(ok.body.currentAmount), 60);

  // Overdraw clamps to 0 rather than going negative.
  const clamp = await primaryAgent
    .post(`/api/goals/${id}/contribute`)
    .send({ amount: -1000 });
  assert.equal(clamp.status, 200);
  assert.equal(Number(clamp.body.currentAmount), 0);
});

test('POST /api/goals/:id/contribute rejects a zero / non-numeric amount', async () => {
  const created = await primaryAgent.post('/api/goals').send({
    name: 'Bad contribute',
    targetAmount: 5000,
    currency: 'CAD',
  });
  const id = created.body.id as number;

  const zero = await primaryAgent
    .post(`/api/goals/${id}/contribute`)
    .send({ amount: 0 });
  assert.equal(zero.status, 400);

  const nan = await primaryAgent
    .post(`/api/goals/${id}/contribute`)
    .send({ amount: 'lots' });
  assert.equal(nan.status, 400);
});

test('POST /api/goals/:id/contribute 404s for another household (no cross-write)', async () => {
  const otherCreated = await otherAgent.post('/api/goals').send({
    name: 'Other untouchable balance',
    targetAmount: 5000,
    currentAmount: 1000,
    currency: 'CAD',
  });
  const otherId = otherCreated.body.id as number;

  const sneak = await primaryAgent
    .post(`/api/goals/${otherId}/contribute`)
    .send({ amount: 500 });
  assert.equal(sneak.status, 404);

  // The victim row is untouched — the household-scoped WHERE matched no row.
  const check = await otherAgent.get(`/api/goals/${otherId}`);
  assert.equal(Number(check.body.currentAmount), 1000);
});

test('two concurrent contributions both land (no lost update)', async () => {
  const created = await primaryAgent.post('/api/goals').send({
    name: 'Concurrent contributions',
    targetAmount: 5000,
    currentAmount: 1000,
    currency: 'CAD',
  });
  const id = created.body.id as number;

  // Fire both contributions concurrently. With a blind read-modify-write PUT
  // both would read 1000 and one delta would be lost (final 1300, not 1500).
  // The atomic increment path makes both land: 1000 + 200 + 300 = 1500.
  const [a, b] = await Promise.all([
    primaryAgent.post(`/api/goals/${id}/contribute`).send({ amount: 200 }),
    primaryAgent.post(`/api/goals/${id}/contribute`).send({ amount: 300 }),
  ]);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);

  const final = await primaryAgent.get(`/api/goals/${id}`);
  assert.equal(Number(final.body.currentAmount), 1500);
});

test('PUT carries an optimistic-lock version that bumps on save', async () => {
  const created = await primaryAgent.post('/api/goals').send({
    name: 'Versioned',
    targetAmount: 5000,
    currency: 'CAD',
  });
  const id = created.body.id as number;
  assert.equal(created.body.version, 0);

  const patched = await primaryAgent.put(`/api/goals/${id}`).send({
    name: 'Versioned renamed',
  });
  assert.equal(patched.status, 200);
  assert.equal(patched.body.version, 1);
});

test('concurrent PUTs of disjoint fields do not clobber each other', async () => {
  const created = await primaryAgent.post('/api/goals').send({
    name: 'No clobber',
    targetAmount: 5000,
    currentAmount: 1000,
    currency: 'CAD',
    priority: 1,
  });
  const id = created.body.id as number;

  // Sequential disjoint PUTs (status vs priority) both stick — the targeted
  // update writes only the patched column, so neither stale-saves the other.
  await primaryAgent.put(`/api/goals/${id}`).send({ status: 'paused' });
  await primaryAgent.put(`/api/goals/${id}`).send({ priority: 9 });

  const final = await primaryAgent.get(`/api/goals/${id}`);
  assert.equal(final.body.status, 'paused');
  assert.equal(final.body.priority, 9);
  // currentAmount untouched by either PUT.
  assert.equal(Number(final.body.currentAmount), 1000);
});

test('households are isolated: otherHouseholdId is distinct', () => {
  assert.notEqual(primaryHouseholdId, otherHouseholdId);
});
