/**
 * Integration tests for /api/goals. Run in isolation
 * (`yarn test:integration`) so DATABASE_URL is set before any Sequelize
 * import.
 *
 * Mirrors the planned_events integration pattern: bootstrap a superadmin,
 * seed two non-superadmin households (each with one account) so we can
 * exercise cross-household isolation via real session cookies.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import request from 'supertest';
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
    name: `${emailPrefix} checking`,
    accountType: 'chequing',
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

  const bootstrap = request.agent(app);
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

// ---- POST ----------------------------------------------------------------

test('POST /api/goals creates a minimal active goal', async () => {
  const res = await primaryAgent.post('/api/goals').send({
    name: 'Emergency fund',
    targetAmount: 10000,
    currency: 'CAD',
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.name, 'Emergency fund');
  assert.equal(Number(res.body.targetAmount), 10000);
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

test('POST /api/goals creates a fully-specified goal linked to an account', async () => {
  const res = await primaryAgent.post('/api/goals').send({
    name: 'Vacation',
    targetAmount: 5000,
    currentAmount: 500,
    currency: 'USD',
    targetDate: '2027-06-01',
    monthlyContribution: 250,
    linkedAccountId: primaryAccountId,
    priority: 2,
    notes: 'Family trip',
  });
  assert.equal(res.status, 201);
  assert.equal(Number(res.body.targetAmount), 5000);
  assert.equal(Number(res.body.currentAmount), 500);
  assert.equal(res.body.currency, 'USD');
  assert.equal(res.body.targetDate, '2027-06-01');
  assert.equal(Number(res.body.monthlyContribution), 250);
  assert.equal(res.body.linkedAccountId, primaryAccountId);
  assert.equal(res.body.priority, 2);
  assert.equal(res.body.notes, 'Family trip');
});

test('POST /api/goals rejects missing name', async () => {
  const res = await primaryAgent.post('/api/goals').send({
    targetAmount: 100,
    currency: 'CAD',
  });
  assert.equal(res.status, 400);
});

test('POST /api/goals rejects zero targetAmount', async () => {
  const res = await primaryAgent.post('/api/goals').send({
    name: 'Trip',
    targetAmount: 0,
    currency: 'CAD',
  });
  assert.equal(res.status, 400);
});

test('POST /api/goals rejects bad currency', async () => {
  const res = await primaryAgent.post('/api/goals').send({
    name: 'Trip',
    targetAmount: 100,
    currency: 'CA',
  });
  assert.equal(res.status, 400);
});

test('POST /api/goals rejects bad date format', async () => {
  const res = await primaryAgent.post('/api/goals').send({
    name: 'Trip',
    targetAmount: 100,
    currency: 'CAD',
    targetDate: '06/01/2027',
  });
  assert.equal(res.status, 400);
});

test('POST /api/goals rejects an account from another household', async () => {
  const res = await primaryAgent.post('/api/goals').send({
    name: 'Sneaky',
    targetAmount: 100,
    currency: 'CAD',
    linkedAccountId: otherAccountId,
  });
  assert.equal(res.status, 400);
});

// ---- GET list ------------------------------------------------------------

test('GET /api/goals returns rows sorted by priority DESC then targetDate ASC', async () => {
  // priority=2 Vacation should outrank priority=0 Emergency fund.
  const list = await primaryAgent.get('/api/goals');
  assert.equal(list.status, 200);
  const rows = list.body.data as Array<{ priority: number; name: string }>;
  assert.ok(rows.length >= 2);
  for (let i = 1; i < rows.length; i++) {
    assert.ok(
      rows[i - 1].priority >= rows[i].priority,
      `expected priority sorted DESC, got ${rows[i - 1].name}(${rows[i - 1].priority}) then ${rows[i].name}(${rows[i].priority})`,
    );
  }
  assert.equal(rows[0].name, 'Vacation');
});

test('GET /api/goals supports status filter', async () => {
  const list = await primaryAgent.get('/api/goals').query({ status: 'active' });
  assert.equal(list.status, 200);
  const rows = list.body.data as Array<{ status: string }>;
  assert.ok(rows.length > 0);
  for (const row of rows) assert.equal(row.status, 'active');
});

test('GET /api/goals supports currency filter', async () => {
  const list = await primaryAgent.get('/api/goals').query({ currency: 'USD' });
  assert.equal(list.status, 200);
  const rows = list.body.data as Array<{ currency: string }>;
  for (const row of rows) assert.equal(row.currency, 'USD');
});

test('GET /api/goals does not leak rows from another household', async () => {
  const otherCreated = await otherAgent.post('/api/goals').send({
    name: 'Other emergency fund',
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

// ---- GET single + projection --------------------------------------------

test('GET /api/goals/:id returns a single row', async () => {
  const created = await primaryAgent.post('/api/goals').send({
    name: 'Car down payment',
    targetAmount: 8000,
    currency: 'CAD',
  });
  const id = created.body.id as number;
  const res = await primaryAgent.get(`/api/goals/${id}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.id, id);
  assert.equal(res.body.name, 'Car down payment');
});

test('GET /api/goals/:id 404s for another household', async () => {
  const otherCreated = await otherAgent.post('/api/goals').send({
    name: 'Other thing',
    targetAmount: 12,
    currency: 'CAD',
  });
  const otherId = otherCreated.body.id as number;
  const sneak = await primaryAgent.get(`/api/goals/${otherId}`);
  assert.equal(sneak.status, 404);
});

test('GET /api/goals/:id/projection returns projection for a no-deadline goal', async () => {
  const created = await primaryAgent.post('/api/goals').send({
    name: 'Open-ended fund',
    targetAmount: 5000,
    currency: 'CAD',
  });
  const id = created.body.id as number;
  const res = await primaryAgent.get(`/api/goals/${id}/projection`);
  assert.equal(res.status, 200);
  assert.equal(res.body.goalId, id);
  assert.equal(res.body.onTrackStatus, 'no_deadline');
  assert.equal(res.body.requiredMonthlyContribution, null);
  assert.equal(res.body.monthsRemaining, null);
});

test('GET /api/goals/:id/projection 404s for another household', async () => {
  const otherCreated = await otherAgent.post('/api/goals').send({
    name: 'Other private',
    targetAmount: 50,
    currency: 'CAD',
  });
  const otherId = otherCreated.body.id as number;
  const sneak = await primaryAgent.get(`/api/goals/${otherId}/projection`);
  assert.equal(sneak.status, 404);
});

// ---- PUT -----------------------------------------------------------------

test('PUT /api/goals/:id patches partial fields', async () => {
  const created = await primaryAgent.post('/api/goals').send({
    name: 'Initial',
    targetAmount: 100,
    currency: 'CAD',
  });
  const id = created.body.id as number;

  const patched = await primaryAgent.put(`/api/goals/${id}`).send({
    name: 'Renamed',
    currentAmount: 50,
    status: 'paused',
    priority: 5,
  });
  assert.equal(patched.status, 200);
  assert.equal(patched.body.name, 'Renamed');
  assert.equal(Number(patched.body.currentAmount), 50);
  assert.equal(patched.body.status, 'paused');
  assert.equal(patched.body.priority, 5);
  assert.equal(patched.body.currency, 'CAD');
});

test('PUT /api/goals/:id allows clearing targetDate via null', async () => {
  const created = await primaryAgent.post('/api/goals').send({
    name: 'With date',
    targetAmount: 100,
    currency: 'CAD',
    targetDate: '2027-06-01',
  });
  const id = created.body.id as number;

  const patched = await primaryAgent.put(`/api/goals/${id}`).send({
    targetDate: null,
  });
  assert.equal(patched.status, 200);
  assert.equal(patched.body.targetDate, null);
});

test('PUT /api/goals/:id rejects switching to an account in another household', async () => {
  const created = await primaryAgent.post('/api/goals').send({
    name: 'Boundary check',
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
    name: 'Other private',
    targetAmount: 50,
    currency: 'CAD',
  });
  const otherId = otherCreated.body.id as number;
  const sneak = await primaryAgent.put(`/api/goals/${otherId}`).send({
    name: 'Pwn3d',
  });
  assert.equal(sneak.status, 404);
});

// ---- DELETE --------------------------------------------------------------

test('DELETE /api/goals/:id removes the row for the owning household', async () => {
  const created = await primaryAgent.post('/api/goals').send({
    name: 'Will be deleted',
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

// ---- summary/required-contributions -------------------------------------

test('GET /api/goals/summary/required-contributions sums active goals by currency', async () => {
  // Wipe out anything created above (different fixtures across tests) by
  // creating a brand-new household just for this test would change the test
  // shape too much — instead, just add a known-state goal and verify it's
  // included with the expected currency bucket present.
  const farFuture = '2030-05-26';
  const created = await primaryAgent.post('/api/goals').send({
    name: 'Required check',
    targetAmount: 12000,
    currency: 'EUR',
    targetDate: farFuture,
  });
  assert.equal(created.status, 201);

  const res = await primaryAgent.get('/api/goals/summary/required-contributions');
  assert.equal(res.status, 200);
  assert.ok(typeof res.body.byCurrency === 'object' && res.body.byCurrency !== null);
  assert.ok(typeof res.body.byCurrency.EUR === 'string');
  // 12000 across ~4 years = a positive monthly amount; just check > 0.
  assert.ok(Number(res.body.byCurrency.EUR) > 0);
});

test('GET /api/goals/summary/required-contributions does not leak across households', async () => {
  const otherRes = await otherAgent.get('/api/goals/summary/required-contributions');
  assert.equal(otherRes.status, 200);
  // Other household created at least 1 goal above but none had a target_date,
  // so the byCurrency map should be empty (no required contribution).
  assert.deepEqual(otherRes.body.byCurrency, {});
});

// ---- sanity --------------------------------------------------------------

test('households are isolated: otherHouseholdId is distinct', () => {
  assert.notEqual(primaryHouseholdId, otherHouseholdId);
});
