/**
 * Integration tests for the financial scenario planner (issue #213).
 *
 * Each test mints its own household so scenarios don't bleed. Covers the AC:
 *  - create a scenario from the current forecast
 *  - modify assumptions (income / expense / savings / one-off)
 *  - scenario does NOT mutate real transactions or planned events
 *  - compare base vs scenario: projected balance, safe-to-spend, net worth
 *  - list / get(recompute) / delete + cross-household isolation
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import request from 'supertest';
import { setupPgTestDb, teardownPgTestDb, type PgTestDb } from './_setup/pgTestDb.js';

let app: import('express').Express;
let testDb: PgTestDb;

type Seeded = {
  householdId: number;
  userId: number;
  accountId: number;
  agent: ReturnType<typeof request.agent>;
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
    name: `${emailPrefix} chequing`,
    accountType: 'chequing',
    defaultCurrency: 'CAD',
    shortCode: emailPrefix.slice(0, 3).toUpperCase(),
    openingBalance: '0',
  });
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24);
  await models.Session.create({
    userId: user.id,
    tokenHash: hashToken(token),
    expiresAt,
  });
  const agent = request.agent(app);
  agent.jar.setCookie(`cashflow_session=${token}; Path=/`);
  return { householdId: household.id, userId: user.id, accountId: account.id, agent };
}

async function seedCash(
  accountId: number,
  householdId: number,
  amount: number,
  date = '2026-01-01',
): Promise<void> {
  const models = await import('../../src/models');
  await models.Transaction.create({
    accountId,
    householdId,
    visibility: 'shared',
    ownershipType: 'me',
    importBatch: 'scenario-test',
    date,
    merchantRaw: 'Seed Deposit',
    merchantClean: 'Seed Deposit',
    amount: amount.toFixed(4),
    currency: 'CAD',
    sourceRowFingerprint: crypto.randomBytes(16).toString('hex'),
    sourceIdentityFingerprint: crypto.randomBytes(16).toString('hex'),
  });
}

before(async () => {
  process.env.NODE_ENV = 'test';
  testDb = await setupPgTestDb('financial_scenarios');
  const mod = await import('../../src/app.js');
  app = mod.default;

  const bootstrap = request.agent(app);
  const register = await bootstrap.post('/api/auth/register').send({
    email: 'superadmin@example.com',
    displayName: 'Super Admin',
    password: 'password123',
  });
  assert.equal(register.status, 201);
});

after(async () => {
  await teardownPgTestDb(testDb);
});

test('POST creates a scenario from the current forecast (base reflects cash)', async () => {
  const u = await seed('Create');
  await seedCash(u.accountId, u.householdId, 4000);

  const res = await u.agent.post('/api/financial-scenarios').send({
    name: 'Baseline',
    assumptions: [],
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.name, 'Baseline');
  assert.equal(res.body.currency, 'CAD');
  assert.equal(res.body.horizonDays, 90);
  assert.ok(res.body.result, 'result should be populated');
  // No assumptions → base equals scenario, no cash deltas.
  assert.equal(res.body.result.base.projectedClosingBalance, 4000);
  assert.equal(res.body.result.scenario.projectedClosingBalance, 4000);
  assert.equal(res.body.result.deltas.projectedClosingBalance, 0);
  assert.equal(res.body.result.base.safeToSpend, 4000);
});

test('income_pct assumption lowers projected balance vs base', async () => {
  const u = await seed('IncomeDrop');
  await seedCash(u.accountId, u.householdId, 1000);

  const models = await import('../../src/models');
  await models.PlannedEvent.create({
    userId: u.userId,
    householdId: u.householdId,
    accountId: u.accountId,
    type: 'income',
    name: 'Paycheck',
    amount: '5000',
    currency: 'CAD',
    expectedDate: '2026-06-15',
    status: 'planned',
    source: 'manual',
  });

  const res = await u.agent.post('/api/financial-scenarios').send({
    name: 'Income drops 30%',
    assumptions: [{ kind: 'income_pct', pct: -0.3 }],
  });
  assert.equal(res.status, 201);
  const { base, scenario, deltas } = res.body.result;
  // base income 5000 fully counted; scenario income 3500 → -1500 delta.
  assert.equal(scenario.projectedClosingBalance, base.projectedClosingBalance - 1500);
  assert.equal(deltas.projectedClosingBalance, -1500);
});

test('one_off expense (buy a car) shows up as a negative delta', async () => {
  const u = await seed('BuyCar');
  await seedCash(u.accountId, u.householdId, 30000);

  const res = await u.agent.post('/api/financial-scenarios').send({
    name: 'Buy a car',
    horizonDays: 90,
    assumptions: [
      { kind: 'one_off', date: '2026-07-01', amount: 25000, direction: 'out' },
    ],
  });
  assert.equal(res.status, 201);
  const { deltas } = res.body.result;
  assert.equal(deltas.projectedClosingBalance, -25000);
  assert.equal(deltas.netWorth, -25000);
});

test('savings_monthly reduces projected balance across the horizon', async () => {
  const u = await seed('SaveMore');
  await seedCash(u.accountId, u.householdId, 10000);

  const res = await u.agent.post('/api/financial-scenarios').send({
    name: 'Save 2k/mo',
    horizonDays: 90,
    assumptions: [{ kind: 'savings_monthly', amount: 2000 }],
  });
  assert.equal(res.status, 201);
  // Over a 90-day window there are ~3 month-starts → ~3 * 2000 parked.
  assert.ok(
    res.body.result.deltas.projectedClosingBalance <= -4000,
    `expected a sizable negative delta, got ${res.body.result.deltas.projectedClosingBalance}`,
  );
});

test('creating a scenario does NOT mutate real transactions or planned events', async () => {
  const u = await seed('NoMutate');
  await seedCash(u.accountId, u.householdId, 5000);

  const models = await import('../../src/models');
  await models.PlannedEvent.create({
    userId: u.userId,
    householdId: u.householdId,
    accountId: u.accountId,
    type: 'expense',
    name: 'Rent',
    amount: '1500',
    currency: 'CAD',
    expectedDate: '2026-06-10',
    status: 'planned',
    source: 'manual',
  });

  const txnBefore = await models.Transaction.count({ where: { householdId: u.householdId } });
  const eventsBefore = await models.PlannedEvent.count({ where: { householdId: u.householdId } });

  const res = await u.agent.post('/api/financial-scenarios').send({
    name: 'Big changes',
    assumptions: [
      { kind: 'income_pct', pct: -0.5 },
      { kind: 'expense_pct', pct: 0.5 },
      { kind: 'savings_monthly', amount: 1000 },
      { kind: 'one_off', date: '2026-07-01', amount: 9000, direction: 'out' },
    ],
  });
  assert.equal(res.status, 201);

  const txnAfter = await models.Transaction.count({ where: { householdId: u.householdId } });
  const eventsAfter = await models.PlannedEvent.count({ where: { householdId: u.householdId } });
  assert.equal(txnAfter, txnBefore, 'transactions must be untouched');
  assert.equal(eventsAfter, eventsBefore, 'planned events must be untouched');
});

test('GET list returns scenarios for the household, newest first', async () => {
  const u = await seed('ListOrder');
  await seedCash(u.accountId, u.householdId, 1000);

  await u.agent.post('/api/financial-scenarios').send({ name: 'First', assumptions: [] });
  await u.agent.post('/api/financial-scenarios').send({ name: 'Second', assumptions: [] });

  const res = await u.agent.get('/api/financial-scenarios');
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.data));
  const names = res.body.data.map((s: { name: string }) => s.name);
  assert.ok(names.includes('First'));
  assert.ok(names.includes('Second'));
  // newest first
  assert.equal(res.body.data[0].name, 'Second');
});

test('GET /:id recomputes against current data', async () => {
  const u = await seed('Recompute');
  await seedCash(u.accountId, u.householdId, 2000);

  const created = await u.agent.post('/api/financial-scenarios').send({
    name: 'Recompute me',
    assumptions: [{ kind: 'one_off', date: '2026-07-01', amount: 500, direction: 'out' }],
  });
  assert.equal(created.status, 201);
  const id = created.body.id;
  assert.equal(created.body.result.base.projectedClosingBalance, 2000);

  // Add more cash after creating the scenario, then GET → base should refresh.
  await seedCash(u.accountId, u.householdId, 3000, '2026-02-01');

  const res = await u.agent.get(`/api/financial-scenarios/${id}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.result.base.projectedClosingBalance, 5000);
  // scenario still subtracts the one-off 500.
  assert.equal(res.body.result.scenario.projectedClosingBalance, 4500);
});

test('DELETE removes a scenario', async () => {
  const u = await seed('Delete');
  await seedCash(u.accountId, u.householdId, 1000);
  const created = await u.agent.post('/api/financial-scenarios').send({ name: 'Doomed', assumptions: [] });
  const id = created.body.id;

  const del = await u.agent.delete(`/api/financial-scenarios/${id}`);
  assert.equal(del.status, 204);

  const after = await u.agent.get(`/api/financial-scenarios/${id}`);
  assert.equal(after.status, 404);
});

test('validation: rejects empty name', async () => {
  const u = await seed('BadName');
  const res = await u.agent.post('/api/financial-scenarios').send({ assumptions: [] });
  assert.equal(res.status, 400);
});

test('validation: rejects an unknown assumption kind', async () => {
  const u = await seed('BadKind');
  const res = await u.agent.post('/api/financial-scenarios').send({
    name: 'x',
    assumptions: [{ kind: 'teleport' }],
  });
  assert.equal(res.status, 400);
});

test('cross-household isolation: a household cannot see another household scenarios', async () => {
  const a = await seed('IsoA');
  const b = await seed('IsoB');
  await seedCash(a.accountId, a.householdId, 1000);
  await seedCash(b.accountId, b.householdId, 2000);

  const created = await a.agent.post('/api/financial-scenarios').send({ name: 'A-only', assumptions: [] });
  assert.equal(created.status, 201);
  const aId = created.body.id;

  // B's list must not include A's scenario.
  const bList = await b.agent.get('/api/financial-scenarios');
  const bNames = bList.body.data.map((s: { name: string }) => s.name);
  assert.ok(!bNames.includes('A-only'));

  // B cannot fetch A's scenario by id.
  const bGet = await b.agent.get(`/api/financial-scenarios/${aId}`);
  assert.equal(bGet.status, 404);

  // B cannot delete A's scenario.
  const bDel = await b.agent.delete(`/api/financial-scenarios/${aId}`);
  assert.equal(bDel.status, 404);
});

test('unauthenticated request returns 401', async () => {
  const fresh = request.agent(app);
  const res = await fresh.get('/api/financial-scenarios');
  assert.equal(res.status, 401);
});
