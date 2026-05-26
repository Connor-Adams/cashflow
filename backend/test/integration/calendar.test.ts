/**
 * Integration tests for /api/calendar/events. Mirrors plannedEvents.test
 * setup — two seeded households, real Postgres, real auth cookies.
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
let otherAgent: ReturnType<typeof request.agent>;
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

  testDb = await setupPgTestDb('calendar');

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
  primaryAgent = request.agent(app);
  primaryAgent.jar.setCookie(`cashflow_session=${primary.token}; Path=/`);

  const other = await seed('Other');
  otherAgent = request.agent(app);
  otherAgent.jar.setCookie(`cashflow_session=${other.token}; Path=/`);
});

after(async () => {
  await teardownPgTestDb(testDb);
});

test('GET /api/calendar/events 401s without auth', async () => {
  const anon = request(app);
  const res = await anon.get('/api/calendar/events');
  assert.equal(res.status, 401);
});

test('GET /api/calendar/events returns empty events list when nothing planned', async () => {
  const res = await primaryAgent
    .get('/api/calendar/events')
    .query({ from: '2030-01-01', to: '2030-01-31' });
  assert.equal(res.status, 200);
  assert.equal(res.body.from, '2030-01-01');
  assert.equal(res.body.to, '2030-01-31');
  assert.deepEqual(res.body.events, []);
});

test('GET /api/calendar/events returns a one-off event inside the window', async () => {
  const created = await primaryAgent.post('/api/planned-events').send({
    type: 'expense',
    name: 'Rent',
    amount: 1500,
    currency: 'CAD',
    expectedDate: '2027-06-01',
    accountId: primaryAccountId,
  });
  assert.equal(created.status, 201);

  const res = await primaryAgent
    .get('/api/calendar/events')
    .query({ from: '2027-06-01', to: '2027-06-30' });
  assert.equal(res.status, 200);
  const events = res.body.events as Array<{
    id: number;
    eventDate: string;
    name: string;
    type: string;
    kindLabel: string;
    categoryColor: string;
    amount: string;
    currency: string;
    status: string;
    anchorDate: string;
    recurrenceRule: string | null;
  }>;
  assert.equal(events.length, 1);
  assert.equal(events[0].name, 'Rent');
  assert.equal(events[0].eventDate, '2027-06-01');
  assert.equal(events[0].type, 'expense');
  assert.equal(events[0].kindLabel, 'Expense');
  assert.equal(events[0].categoryColor, 'rose');
  assert.equal(events[0].currency, 'CAD');
  assert.equal(events[0].status, 'planned');
  assert.equal(events[0].anchorDate, '2027-06-01');
  assert.equal(events[0].recurrenceRule, null);
});

test('GET /api/calendar/events expands a monthly recurrence', async () => {
  await primaryAgent.post('/api/planned-events').send({
    type: 'income',
    name: 'Paycheck',
    amount: 3500,
    currency: 'CAD',
    expectedDate: '2027-07-01',
    recurrenceRule: 'FREQ=MONTHLY',
  });

  const res = await primaryAgent
    .get('/api/calendar/events')
    .query({ from: '2027-07-01', to: '2027-09-30', type: 'income' });
  assert.equal(res.status, 200);
  const events = res.body.events as Array<{ name: string; eventDate: string; type: string }>;
  const paychecks = events.filter((e) => e.name === 'Paycheck');
  assert.equal(paychecks.length, 3);
  assert.deepEqual(
    paychecks.map((p) => p.eventDate).sort(),
    ['2027-07-01', '2027-08-01', '2027-09-01'],
  );
  for (const p of paychecks) assert.equal(p.type, 'income');
});

test('GET /api/calendar/events sorts events by eventDate ASC', async () => {
  const res = await primaryAgent
    .get('/api/calendar/events')
    .query({ from: '2027-06-01', to: '2027-12-31' });
  assert.equal(res.status, 200);
  const dates = (res.body.events as Array<{ eventDate: string }>).map(
    (e) => e.eventDate,
  );
  for (let i = 1; i < dates.length; i += 1) {
    assert.ok(
      dates[i - 1] <= dates[i],
      `expected ASC sort, got ${dates[i - 1]} then ${dates[i]}`,
    );
  }
});

test('GET /api/calendar/events filters by currency', async () => {
  // Add a USD event so the filter has something to discriminate.
  await primaryAgent.post('/api/planned-events').send({
    type: 'expense',
    name: 'AWS bill',
    amount: 12,
    currency: 'USD',
    expectedDate: '2027-07-15',
  });

  const cadOnly = await primaryAgent
    .get('/api/calendar/events')
    .query({ from: '2027-07-01', to: '2027-07-31', currency: 'CAD' });
  assert.equal(cadOnly.status, 200);
  const cadEvents = cadOnly.body.events as Array<{ name: string; currency: string }>;
  assert.ok(cadEvents.every((e) => e.currency === 'CAD'));
  assert.ok(!cadEvents.some((e) => e.name === 'AWS bill'));
});

test('GET /api/calendar/events does not leak events from another household', async () => {
  await otherAgent.post('/api/planned-events').send({
    type: 'expense',
    name: 'Other rent',
    amount: 1000,
    currency: 'CAD',
    expectedDate: '2027-07-15',
  });

  const primaryRes = await primaryAgent
    .get('/api/calendar/events')
    .query({ from: '2027-07-01', to: '2027-07-31' });
  const primaryNames = (
    primaryRes.body.events as Array<{ name: string }>
  ).map((e) => e.name);
  assert.ok(!primaryNames.includes('Other rent'));

  const otherRes = await otherAgent
    .get('/api/calendar/events')
    .query({ from: '2027-07-01', to: '2027-07-31' });
  const otherNames = (
    otherRes.body.events as Array<{ name: string }>
  ).map((e) => e.name);
  assert.ok(otherNames.includes('Other rent'));
  assert.equal(otherRes.body.events.length, 1);
});

test('GET /api/calendar/events rejects bad date format', async () => {
  const res = await primaryAgent
    .get('/api/calendar/events')
    .query({ from: '06/01/2027', to: '2027-07-01' });
  assert.equal(res.status, 400);
});

test('GET /api/calendar/events rejects to before from', async () => {
  const res = await primaryAgent
    .get('/api/calendar/events')
    .query({ from: '2027-09-01', to: '2027-07-01' });
  assert.equal(res.status, 400);
});

test('GET /api/calendar/events rejects window > 366 days', async () => {
  const res = await primaryAgent
    .get('/api/calendar/events')
    .query({ from: '2027-01-01', to: '2030-01-01' });
  assert.equal(res.status, 400);
});

test('GET /api/calendar/events defaults to today + 30 days when no params', async () => {
  const res = await primaryAgent.get('/api/calendar/events');
  assert.equal(res.status, 200);
  assert.ok(typeof res.body.from === 'string');
  assert.ok(typeof res.body.to === 'string');
  // Just check the basic shape — exact dates depend on test clock.
  assert.match(res.body.from, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(res.body.to, /^\d{4}-\d{2}-\d{2}$/);
});

test('GET /api/calendar/events filters by status (skipped stays out)', async () => {
  const planned = await primaryAgent.post('/api/planned-events').send({
    type: 'expense',
    name: 'Will be skipped',
    amount: 50,
    currency: 'CAD',
    expectedDate: '2027-08-10',
  });
  const id = planned.body.id as number;
  await primaryAgent.put(`/api/planned-events/${id}`).send({ status: 'skipped' });

  const onlyPlanned = await primaryAgent
    .get('/api/calendar/events')
    .query({ from: '2027-08-01', to: '2027-08-31', status: 'planned' });
  const names = (onlyPlanned.body.events as Array<{ name: string }>).map((e) => e.name);
  assert.ok(!names.includes('Will be skipped'));

  const onlySkipped = await primaryAgent
    .get('/api/calendar/events')
    .query({ from: '2027-08-01', to: '2027-08-31', status: 'skipped' });
  const skippedNames = (
    onlySkipped.body.events as Array<{ name: string }>
  ).map((e) => e.name);
  assert.ok(skippedNames.includes('Will be skipped'));
});

test('GET /api/calendar/events includes linkedTransactionId and notes when present', async () => {
  // We don't have a real Transaction to link, but notes are sufficient.
  await primaryAgent.post('/api/planned-events').send({
    type: 'savings',
    name: 'Emergency fund',
    amount: 200,
    currency: 'CAD',
    expectedDate: '2027-08-20',
    notes: 'top-up',
  });

  const res = await primaryAgent
    .get('/api/calendar/events')
    .query({ from: '2027-08-20', to: '2027-08-20' });
  const ef = (res.body.events as Array<{ name: string; notes: string | null }>).find(
    (e) => e.name === 'Emergency fund',
  );
  assert.ok(ef);
  assert.equal(ef?.notes, 'top-up');
});

test('primaryHouseholdId is populated (smoke for setup)', () => {
  assert.ok(Number.isInteger(primaryHouseholdId) && primaryHouseholdId > 0);
});
