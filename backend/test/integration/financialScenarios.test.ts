/**
 * Integration tests for the financial scenario planner API (issue #213).
 *
 * Exercises:
 *   GET    /api/financial-scenarios
 *   POST   /api/financial-scenarios
 *   GET    /api/financial-scenarios/:id
 *   PATCH  /api/financial-scenarios/:id
 *   DELETE /api/financial-scenarios/:id
 *   POST   /api/financial-scenarios/:id/recompute
 *
 * Isolation tests: cross-household access is blocked.
 *
 * Acceptance criteria coverage:
 *   AC1 — Create scenario from current forecast: POST creates + runs forecast.
 *   AC2 — Modify assumptions: PATCH updates + recomputes.
 *   AC3 — Scenario does not mutate real transactions/events.
 *   AC4 — Compare base vs scenario: result_json contains baseline + scenario + deltas.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import request from 'supertest';
import { testAgent, testRequest } from './_setup/testServer.js';
import { setupPgTestDb, teardownPgTestDb, type PgTestDb } from './_setup/pgTestDb.js';

let app: import('express').Express;
let testDb: PgTestDb;

type Seeded = {
  token: string;
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
  await models.Account.create({
    householdId: household.id,
    ownerUserId: user.id,
    owner: 'me',
    visibility: 'shared',
    name: `${emailPrefix} chequing`,
    accountType: 'chequing',
    defaultCurrency: 'CAD',
    shortCode: emailPrefix.slice(0, 3).toUpperCase(),
    openingBalance: '10000',
  });
  const accountId = (
    await models.Account.findOne({ where: { householdId: household.id } })
  )!.id;
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24);
  await models.Session.create({
    userId: user.id,
    tokenHash: hashToken(token),
    expiresAt,
  });
  const agent = testAgent(app);
  agent.jar.setCookie(`cashflow_session=${token}; Path=/`);
  return { token, householdId: household.id, userId: user.id, accountId, agent };
}

before(async () => {
  testDb = await setupPgTestDb('financial_scenarios');
  const appModule = await import('../../src/app.js');
  app = appModule.default;
});

after(async () => {
  await teardownPgTestDb(testDb);
});

// ---------------------------------------------------------------------------
// AC1 — Create scenario from current forecast
// ---------------------------------------------------------------------------

test('POST /api/financial-scenarios: creates and returns scenario with result_json', async () => {
  const { agent } = await seed('create-basic');
  const body = {
    name: 'What if I buy a car',
    overrides: [
      {
        label: 'Car purchase',
        type: 'one_off',
        amount: 20000,
        startDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
        direction: 'out',
      },
    ],
  };
  const res = await agent.post('/api/financial-scenarios').send(body);
  assert.equal(res.status, 201, `Expected 201, got ${res.status}: ${JSON.stringify(res.body)}`);
  assert.ok(res.body.id, 'Should have an id');
  assert.equal(res.body.name, 'What if I buy a car');
  // result_json must be populated on creation
  assert.ok(res.body.resultJson, 'result_json should be populated immediately');
  assert.ok(typeof res.body.resultJson.baseline === 'object', 'result_json.baseline should exist');
  assert.ok(typeof res.body.resultJson.scenario === 'object', 'result_json.scenario should exist');
  assert.ok(typeof res.body.resultJson.deltas === 'object', 'result_json.deltas should exist');
  // Buying a car should reduce the scenario closing balance vs baseline
  assert.ok(
    res.body.resultJson.deltas.closing < 0,
    `Car purchase should lower closing balance: delta was ${res.body.resultJson.deltas.closing}`,
  );
});

test('POST /api/financial-scenarios: income assumption increases scenario closing', async () => {
  const { agent } = await seed('income-scenario');
  const nextWeek = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const body = {
    name: 'What if I get a bonus',
    overrides: [
      {
        label: 'Year-end bonus',
        type: 'income',
        amount: 5000,
        startDate: nextWeek,
      },
    ],
  };
  const res = await agent.post('/api/financial-scenarios').send(body);
  assert.equal(res.status, 201);
  assert.ok(res.body.resultJson.deltas.closing > 0, 'Bonus should increase closing balance');
});

test('POST /api/financial-scenarios: returns 400 for missing name', async () => {
  const { agent } = await seed('no-name');
  const res = await agent.post('/api/financial-scenarios').send({ overrides: [] });
  assert.equal(res.status, 400);
  assert.ok(res.body.error, 'Should return an error message');
});

test('POST /api/financial-scenarios: returns 400 for invalid assumption type', async () => {
  const { agent } = await seed('bad-type');
  const body = {
    name: 'Bad type scenario',
    overrides: [
      {
        label: 'Debt payoff',
        type: 'debt_payoff', // not supported yet
        amount: 5000,
        startDate: '2026-07-01',
      },
    ],
  };
  const res = await agent.post('/api/financial-scenarios').send(body);
  assert.equal(res.status, 400);
});

test('POST /api/financial-scenarios: returns 400 for invalid baselineDays', async () => {
  const { agent } = await seed('bad-days');
  const body = {
    name: 'Bad days',
    overrides: [],
    baselineDays: 45, // not 30/60/90
  };
  const res = await agent.post('/api/financial-scenarios').send(body);
  assert.equal(res.status, 400);
});

// ---------------------------------------------------------------------------
// AC2 — List and fetch
// ---------------------------------------------------------------------------

test('GET /api/financial-scenarios: returns all scenarios for household', async () => {
  const { agent } = await seed('list-scenarios');
  await agent.post('/api/financial-scenarios').send({ name: 'Scenario A', overrides: [] });
  await agent.post('/api/financial-scenarios').send({ name: 'Scenario B', overrides: [] });

  const res = await agent.get('/api/financial-scenarios');
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.data));
  assert.ok(res.body.data.length >= 2);
  const names = res.body.data.map((s: { name: string }) => s.name);
  assert.ok(names.includes('Scenario A'));
  assert.ok(names.includes('Scenario B'));
});

test('GET /api/financial-scenarios/:id: returns individual scenario', async () => {
  const { agent } = await seed('get-one');
  const post = await agent
    .post('/api/financial-scenarios')
    .send({ name: 'Fetch me', overrides: [] });
  const id = post.body.id;

  const res = await agent.get(`/api/financial-scenarios/${id}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.id, id);
  assert.equal(res.body.name, 'Fetch me');
});

test('GET /api/financial-scenarios/:id: returns 404 for unknown id', async () => {
  const { agent } = await seed('get-404');
  const res = await agent.get('/api/financial-scenarios/999999');
  assert.equal(res.status, 404);
});

// ---------------------------------------------------------------------------
// AC2 — Modify assumptions
// ---------------------------------------------------------------------------

test('PATCH /api/financial-scenarios/:id: updates name', async () => {
  const { agent } = await seed('patch-name');
  const post = await agent
    .post('/api/financial-scenarios')
    .send({ name: 'Original name', overrides: [] });
  const id = post.body.id;

  const res = await agent
    .patch(`/api/financial-scenarios/${id}`)
    .send({ name: 'Updated name', overrides: [] });
  assert.equal(res.status, 200);
  assert.equal(res.body.name, 'Updated name');
});

test('PATCH /api/financial-scenarios/:id: recomputes result_json when assumptions change', async () => {
  const { agent } = await seed('patch-assumptions');
  const post = await agent
    .post('/api/financial-scenarios')
    .send({ name: 'Start', overrides: [] });
  const id = post.body.id;
  const originalClosing = post.body.resultJson?.scenario?.closing ?? 0;

  const nextWeek = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const patchRes = await agent.patch(`/api/financial-scenarios/${id}`).send({
    name: 'Updated',
    overrides: [
      {
        label: 'New expense',
        type: 'expense',
        amount: 3000,
        startDate: nextWeek,
      },
    ],
  });
  assert.equal(patchRes.status, 200);
  // Adding a 3000 expense should change the closing balance
  const newClosing = patchRes.body.resultJson?.scenario?.closing ?? 0;
  assert.notEqual(
    newClosing,
    originalClosing,
    'Closing balance should change after adding expense assumption',
  );
});

// ---------------------------------------------------------------------------
// AC3 — Scenario does not mutate real transactions/events
// ---------------------------------------------------------------------------

test('POST /api/financial-scenarios: does not create or modify PlannedEvents', async () => {
  const { agent, householdId } = await seed('no-mutation');
  const models = await import('../../src/models');

  // Count PlannedEvents before
  const before = await models.PlannedEvent.count({ where: { householdId } });

  await agent.post('/api/financial-scenarios').send({
    name: 'Test scenario',
    overrides: [
      {
        label: 'Hypothetical income',
        type: 'income',
        amount: 5000,
        startDate: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
      },
    ],
  });

  // Count PlannedEvents after — must be unchanged
  const after = await models.PlannedEvent.count({ where: { householdId } });
  assert.equal(before, after, 'Scenario creation must not create PlannedEvents');
});

// ---------------------------------------------------------------------------
// AC4 — Compare base vs scenario
// ---------------------------------------------------------------------------

test('result_json contains baseline, scenario, and deltas', async () => {
  const { agent } = await seed('compare');
  const nextWeek = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const res = await agent.post('/api/financial-scenarios').send({
    name: 'Comparison test',
    overrides: [
      {
        label: 'Expense',
        type: 'expense',
        amount: 1000,
        startDate: nextWeek,
      },
    ],
  });
  assert.equal(res.status, 201);
  const rj = res.body.resultJson;
  assert.ok(rj.baseline, 'baseline must exist');
  assert.ok(typeof rj.baseline.closing === 'number', 'baseline.closing must be a number');
  assert.ok(typeof rj.baseline.lowest === 'number');
  assert.ok(Array.isArray(rj.baseline.dailyPoints), 'baseline.dailyPoints must be an array');
  assert.ok(rj.scenario, 'scenario must exist');
  assert.ok(typeof rj.scenario.closing === 'number');
  assert.ok(Array.isArray(rj.scenario.dailyPoints));
  assert.ok(rj.deltas, 'deltas must exist');
  assert.ok(typeof rj.deltas.closing === 'number');
  assert.ok(typeof rj.deltas.lowest === 'number');
  assert.ok(typeof rj.deltas.lowestDateChanged === 'boolean');
  // Expense of 1000 should produce delta of -1000
  assert.equal(rj.deltas.closing, -1000);
});

// ---------------------------------------------------------------------------
// POST /:id/recompute
// ---------------------------------------------------------------------------

test('POST /api/financial-scenarios/:id/recompute: updates result_json', async () => {
  const { agent } = await seed('recompute');
  const post = await agent
    .post('/api/financial-scenarios')
    .send({ name: 'Recompute test', overrides: [] });
  const id = post.body.id;

  const res = await agent.post(`/api/financial-scenarios/${id}/recompute`);
  assert.equal(res.status, 200);
  assert.ok(res.body.resultJson, 'result_json should be populated after recompute');
  assert.ok(typeof res.body.resultJson.baseline === 'object');
});

test('POST /api/financial-scenarios/:id/recompute: returns 404 for unknown id', async () => {
  const { agent } = await seed('recompute-404');
  const res = await agent.post('/api/financial-scenarios/999999/recompute');
  assert.equal(res.status, 404);
});

// ---------------------------------------------------------------------------
// DELETE
// ---------------------------------------------------------------------------

test('DELETE /api/financial-scenarios/:id: removes scenario', async () => {
  const { agent } = await seed('delete-scenario');
  const post = await agent
    .post('/api/financial-scenarios')
    .send({ name: 'To delete', overrides: [] });
  const id = post.body.id;

  const del = await agent.delete(`/api/financial-scenarios/${id}`);
  assert.equal(del.status, 204);

  const get = await agent.get(`/api/financial-scenarios/${id}`);
  assert.equal(get.status, 404);
});

// ---------------------------------------------------------------------------
// Cross-household isolation
// ---------------------------------------------------------------------------

test('Cross-household: user A cannot access user B scenario', async () => {
  const userA = await seed('isolation-a');
  const userB = await seed('isolation-b');

  const post = await userA.agent
    .post('/api/financial-scenarios')
    .send({ name: 'User A scenario', overrides: [] });
  const idA = post.body.id;
  assert.ok(idA, 'Scenario created');

  // User B tries to GET user A's scenario
  const get = await userB.agent.get(`/api/financial-scenarios/${idA}`);
  assert.equal(get.status, 404, 'User B should get 404 for user A scenario');

  // User B tries to PATCH user A's scenario
  const patch = await userB.agent
    .patch(`/api/financial-scenarios/${idA}`)
    .send({ name: 'Hijacked', overrides: [] });
  assert.equal(patch.status, 404);

  // User B tries to DELETE user A's scenario
  const del = await userB.agent.delete(`/api/financial-scenarios/${idA}`);
  assert.equal(del.status, 404);
});

// ---------------------------------------------------------------------------
// Unauthenticated access
// ---------------------------------------------------------------------------

test('GET /api/financial-scenarios: returns 401 when not logged in', async () => {
  const res = await testRequest(app).get('/api/financial-scenarios');
  assert.ok(res.status === 401 || res.status === 403, `Expected 401/403, got ${res.status}`);
});
