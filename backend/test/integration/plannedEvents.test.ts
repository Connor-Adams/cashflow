/**
 * Integration tests for /api/planned-events. Run in isolation
 * (`yarn test:integration`) so DATABASE_URL is set before any Sequelize
 * import.
 *
 * Pattern mirrors `settlements.test.ts` and `budgets.test.ts`: bootstrap a
 * superadmin, then seed two non-superadmin households so cross-household
 * isolation can be exercised via real session cookies. Each household also
 * gets its own account (planned events can optionally reference one).
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

  testDb = await setupPgTestDb('planned_events');

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

test('POST /api/planned-events creates a one-off expense', async () => {
  const res = await primaryAgent.post('/api/planned-events').send({
    type: 'expense',
    name: 'Rent',
    amount: 1500,
    currency: 'CAD',
    expectedDate: '2026-07-01',
    accountId: primaryAccountId,
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.type, 'expense');
  assert.equal(res.body.name, 'Rent');
  assert.equal(Number(res.body.amount), 1500);
  assert.equal(res.body.currency, 'CAD');
  assert.equal(res.body.expectedDate, '2026-07-01');
  assert.equal(res.body.source, 'manual');
  assert.equal(res.body.status, 'planned');
  assert.equal(res.body.recurrenceRule, null);
  assert.equal(res.body.linkedTransactionId, null);
  assert.equal(res.body.householdId, primaryHouseholdId);
  assert.equal(res.body.userId, primaryUserId);
  assert.equal(res.body.accountId, primaryAccountId);
});

test('POST /api/planned-events creates a recurring income with rrule', async () => {
  const res = await primaryAgent.post('/api/planned-events').send({
    type: 'income',
    name: 'Paycheck',
    amount: 3500,
    currency: 'CAD',
    expectedDate: '2026-06-15',
    recurrenceRule: 'FREQ=MONTHLY;BYMONTHDAY=15',
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.type, 'income');
  assert.equal(res.body.recurrenceRule, 'FREQ=MONTHLY;BYMONTHDAY=15');
  assert.equal(res.body.accountId, null);
});

test('POST /api/planned-events rejects invalid type', async () => {
  const res = await primaryAgent.post('/api/planned-events').send({
    type: 'gift',
    name: 'Birthday',
    amount: 50,
    currency: 'CAD',
    expectedDate: '2026-06-15',
  });
  assert.equal(res.status, 400);
});

test('POST /api/planned-events rejects bad date format', async () => {
  const res = await primaryAgent.post('/api/planned-events').send({
    type: 'expense',
    name: 'Rent',
    amount: 100,
    currency: 'CAD',
    expectedDate: '06/01/2026',
  });
  assert.equal(res.status, 400);
});

test('POST /api/planned-events rejects an account from another household', async () => {
  const res = await primaryAgent.post('/api/planned-events').send({
    type: 'expense',
    name: 'Sneaky',
    amount: 10,
    currency: 'CAD',
    expectedDate: '2026-06-01',
    accountId: otherAccountId,
  });
  assert.equal(res.status, 400);
});

test('GET /api/planned-events returns rows sorted by expectedDate ASC', async () => {
  // Add an earlier-dated event after the previous ones so order matters.
  const earlier = await primaryAgent.post('/api/planned-events').send({
    type: 'expense',
    name: 'Earlier bill',
    amount: 25,
    currency: 'CAD',
    expectedDate: '2026-05-30',
  });
  assert.equal(earlier.status, 201);

  const list = await primaryAgent.get('/api/planned-events');
  assert.equal(list.status, 200);
  const rows = list.body.data as Array<{ expectedDate: string }>;
  assert.ok(rows.length >= 3);
  for (let i = 1; i < rows.length; i++) {
    assert.ok(
      rows[i - 1].expectedDate <= rows[i].expectedDate,
      `expected sorted ASC, got ${rows[i - 1].expectedDate} then ${rows[i].expectedDate}`,
    );
  }
});

test('GET /api/planned-events supports type filter', async () => {
  const list = await primaryAgent
    .get('/api/planned-events')
    .query({ type: 'income' });
  assert.equal(list.status, 200);
  const rows = list.body.data as Array<{ type: string }>;
  assert.ok(rows.length > 0);
  for (const row of rows) assert.equal(row.type, 'income');
});

test('GET /api/planned-events supports status filter', async () => {
  const list = await primaryAgent
    .get('/api/planned-events')
    .query({ status: 'planned' });
  assert.equal(list.status, 200);
  const rows = list.body.data as Array<{ status: string }>;
  for (const row of rows) assert.equal(row.status, 'planned');
});

test('GET /api/planned-events supports date range filter', async () => {
  const list = await primaryAgent
    .get('/api/planned-events')
    .query({ dateFrom: '2026-07-01', dateTo: '2026-07-31' });
  assert.equal(list.status, 200);
  const rows = list.body.data as Array<{ expectedDate: string }>;
  for (const row of rows) {
    assert.ok(row.expectedDate >= '2026-07-01');
    assert.ok(row.expectedDate <= '2026-07-31');
  }
});

test('GET /api/planned-events does not leak rows from another household', async () => {
  const otherCreated = await otherAgent.post('/api/planned-events').send({
    type: 'expense',
    name: 'Other rent',
    amount: 999,
    currency: 'CAD',
    expectedDate: '2026-08-01',
    accountId: otherAccountId,
  });
  assert.equal(otherCreated.status, 201);

  const otherList = await otherAgent.get('/api/planned-events');
  assert.equal(otherList.status, 200);
  assert.equal(otherList.body.data.length, 1);

  const primaryList = await primaryAgent.get('/api/planned-events');
  const primaryIds = (primaryList.body.data as Array<{ id: number }>).map((r) => r.id);
  assert.ok(!primaryIds.includes(otherCreated.body.id));
});

test('GET /api/planned-events/:id returns a single row', async () => {
  const created = await primaryAgent.post('/api/planned-events').send({
    type: 'savings',
    name: 'Emergency fund top-up',
    amount: 250,
    currency: 'CAD',
    expectedDate: '2026-06-30',
  });
  const id = created.body.id as number;
  const res = await primaryAgent.get(`/api/planned-events/${id}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.id, id);
  assert.equal(res.body.type, 'savings');
});

test('GET /api/planned-events/:id 404s for another household', async () => {
  const otherCreated = await otherAgent.post('/api/planned-events').send({
    type: 'expense',
    name: 'Other thing',
    amount: 12,
    currency: 'CAD',
    expectedDate: '2026-09-01',
  });
  const otherId = otherCreated.body.id as number;
  const sneak = await primaryAgent.get(`/api/planned-events/${otherId}`);
  assert.equal(sneak.status, 404);
});

test('PUT /api/planned-events/:id patches partial fields', async () => {
  const created = await primaryAgent.post('/api/planned-events').send({
    type: 'expense',
    name: 'Initial',
    amount: 100,
    currency: 'CAD',
    expectedDate: '2026-06-01',
  });
  const id = created.body.id as number;

  const patched = await primaryAgent.put(`/api/planned-events/${id}`).send({
    name: 'Renamed',
    amount: 175.5,
    status: 'skipped',
  });
  assert.equal(patched.status, 200);
  assert.equal(patched.body.name, 'Renamed');
  assert.equal(Number(patched.body.amount), 175.5);
  assert.equal(patched.body.status, 'skipped');
  // Untouched fields stick
  assert.equal(patched.body.type, 'expense');
  assert.equal(patched.body.expectedDate, '2026-06-01');
});

test('PUT /api/planned-events/:id rejects switching to an account in another household', async () => {
  const created = await primaryAgent.post('/api/planned-events').send({
    type: 'expense',
    name: 'Boundary check',
    amount: 100,
    currency: 'CAD',
    expectedDate: '2026-06-01',
  });
  const id = created.body.id as number;

  const sneaky = await primaryAgent.put(`/api/planned-events/${id}`).send({
    accountId: otherAccountId,
  });
  assert.equal(sneaky.status, 400);
});

test('PUT /api/planned-events/:id 404s for another household', async () => {
  const otherCreated = await otherAgent.post('/api/planned-events').send({
    type: 'expense',
    name: 'Other private',
    amount: 50,
    currency: 'CAD',
    expectedDate: '2026-10-01',
  });
  const otherId = otherCreated.body.id as number;
  const sneak = await primaryAgent.put(`/api/planned-events/${otherId}`).send({
    name: 'Pwn3d',
  });
  assert.equal(sneak.status, 404);
});

test('DELETE /api/planned-events/:id removes the row for the owning household', async () => {
  const created = await primaryAgent.post('/api/planned-events').send({
    type: 'expense',
    name: 'Will be deleted',
    amount: 5,
    currency: 'CAD',
    expectedDate: '2026-06-01',
  });
  const id = created.body.id as number;

  const wrongHousehold = await otherAgent.delete(`/api/planned-events/${id}`);
  assert.equal(wrongHousehold.status, 404);

  const owner = await primaryAgent.delete(`/api/planned-events/${id}`);
  assert.equal(owner.status, 204);

  const gone = await primaryAgent.delete(`/api/planned-events/${id}`);
  assert.equal(gone.status, 404);
});

test('households are isolated: otherHouseholdId is distinct', () => {
  // Defensive sanity — the two seeded households really are different rows.
  assert.notEqual(primaryHouseholdId, otherHouseholdId);
});
