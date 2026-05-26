/**
 * Integration tests for /api/tax/household-plans CRUD + compute routes
 * (P8b Task 6).
 *
 * Mirrors the auth-setup pattern from routes-corp-scenarios.test.ts:
 * - sequelize.sync({ force: true }) instead of running migrations.
 * - Models imported BEFORE sync so all model tables are registered/created.
 * - Direct User + Household + HouseholdMember + Session creation, then
 *   request.agent(app) with cookie injection.
 *
 * The compute route requires a corp scenario with active business income and
 * a personal scenario linked to the same plan. The seed creates one of each
 * plus a business-revenue txn so the baselines have non-trivial facts.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import crypto from 'crypto';

let app: import('express').Express;
let authed: ReturnType<typeof request.agent>;
let householdId: number;
let personalEntityId: number;
let corpEntityId: number;

before(async () => {
  process.env.NODE_ENV = 'test';
  const { sequelize } = await import('../../src/db.js');
  // Import models BEFORE sync so all model tables are registered/created.
  const models = await import('../../src/models/index.js');
  await sequelize.sync({ force: true });

  const mod = await import('../../src/app.js');
  app = mod.default;

  const { hashPassword, hashToken } = await import('../../src/auth/password.js');

  const password = await hashPassword('password123');
  const user = await models.User.create({
    email: `household-plans-${Date.now()}@example.com`,
    displayName: 'Household Plans Test',
    globalRole: 'user',
    passwordHash: password.hash,
    passwordSalt: password.salt,
    passwordParams: password.params,
  });
  const household = await models.Household.create({ name: 'Household Plans HH' });
  householdId = household.id;
  await models.HouseholdMember.create({
    householdId: household.id,
    userId: user.id,
    role: 'owner',
  });

  const personal = await models.Entity.create({
    householdId: household.id,
    kind: 'personal',
    legalName: 'P',
    jurisdiction: 'CA-ON',
    fiscalYearEnd: null,
  });
  personalEntityId = personal.id;
  const corp = await models.Entity.create({
    householdId: household.id,
    kind: 'corp',
    legalName: 'C',
    jurisdiction: 'CA-ON',
    fiscalYearEnd: '12-31',
  });
  corpEntityId = corp.id;

  // Seed one business-revenue txn so the corp baseline has active business
  // income (so compute returns a non-zero T2).
  const corpAccount = await models.Account.create({
    name: 'CorpChk',
    householdId: household.id,
    accountType: 'checking',
    entityId: corp.id,
    taxStatus: 'non_registered',
    defaultCurrency: 'CAD',
  } as never);
  await models.Transaction.create({
    accountId: corpAccount.id,
    householdId: household.id,
    entityId: corp.id,
    date: '2025-03-15',
    amount: '300000',
    currency: 'CAD',
    finalCategory: 'business_revenue',
    finalBusiness: true,
    merchantRaw: 'C',
    merchantClean: 'C',
    importBatch: 'b',
    sourceRowFingerprint: 'fp1',
    sourceIdentityFingerprint: 'sif1',
  } as never);

  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24);
  await models.Session.create({
    userId: user.id,
    tokenHash: hashToken(token),
    expiresAt,
  });
  authed = request.agent(app);
  authed.jar.setCookie(`cashflow_session=${token}; Path=/`);
});

after(async () => {
  const { sequelize } = await import('../../src/db.js');
  await sequelize.close();
});

// -- Unauthenticated --------------------------------------------------------

test('GET /api/tax/household-plans without auth returns 401', async () => {
  const res = await request(app).get('/api/tax/household-plans');
  assert.equal(
    res.status,
    401,
    `expected 401, got ${res.status}: ${JSON.stringify(res.body)}`,
  );
});

test('POST /api/tax/household-plans without auth returns 401', async () => {
  const res = await request(app).post('/api/tax/household-plans').send({ name: 'X' });
  assert.equal(
    res.status,
    401,
    `expected 401, got ${res.status}: ${JSON.stringify(res.body)}`,
  );
});

// -- CRUD happy paths -------------------------------------------------------

test('POST /api/tax/household-plans creates a plan', async () => {
  const res = await authed
    .post('/api/tax/household-plans')
    .send({ name: 'Salary heavy 2025', notes: 'maximise CPP room' });
  assert.equal(
    res.status,
    201,
    `expected 201, got ${res.status}: ${JSON.stringify(res.body)}`,
  );
  assert.equal(res.body.plan.name, 'Salary heavy 2025');
  assert.equal(res.body.plan.notes, 'maximise CPP room');
  assert.equal(res.body.plan.householdId, householdId);
});

test('POST without name returns 400', async () => {
  const res = await authed.post('/api/tax/household-plans').send({ notes: 'no name' });
  assert.equal(
    res.status,
    400,
    `expected 400, got ${res.status}: ${JSON.stringify(res.body)}`,
  );
  assert.match(res.body.message, /name/i);
});

test('POST with empty-string name returns 400', async () => {
  const res = await authed
    .post('/api/tax/household-plans')
    .send({ name: '   ' });
  assert.equal(
    res.status,
    400,
    `expected 400, got ${res.status}: ${JSON.stringify(res.body)}`,
  );
});

test('GET /api/tax/household-plans lists plans for the household', async () => {
  const res = await authed.get('/api/tax/household-plans');
  assert.equal(
    res.status,
    200,
    `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`,
  );
  assert.ok(Array.isArray(res.body.plans));
  // At least the plan from the create test above.
  assert.ok(res.body.plans.length >= 1);
  assert.ok(res.body.plans.every((p: { householdId: number }) => p.householdId === householdId));
});

test('GET /:id returns the plan + linked scenarios', async () => {
  const create = await authed
    .post('/api/tax/household-plans')
    .send({ name: 'Detail-fetch' });
  const id = create.body.plan.id;
  const res = await authed.get(`/api/tax/household-plans/${id}`);
  assert.equal(
    res.status,
    200,
    `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`,
  );
  assert.equal(res.body.plan.id, id);
  assert.ok(Array.isArray(res.body.scenarios));
  assert.equal(res.body.scenarios.length, 0);
});

test('GET /:id with non-existent ID returns 404', async () => {
  const res = await authed.get('/api/tax/household-plans/999999');
  assert.equal(
    res.status,
    404,
    `expected 404, got ${res.status}: ${JSON.stringify(res.body)}`,
  );
});

test('PATCH /:id updates name + notes', async () => {
  const create = await authed
    .post('/api/tax/household-plans')
    .send({ name: 'Patch-me' });
  const id = create.body.plan.id;
  const res = await authed
    .patch(`/api/tax/household-plans/${id}`)
    .send({ name: 'Patched', notes: 'new notes' });
  assert.equal(
    res.status,
    200,
    `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`,
  );
  assert.equal(res.body.plan.name, 'Patched');
  assert.equal(res.body.plan.notes, 'new notes');
});

test('PATCH /:id can null out notes', async () => {
  const create = await authed
    .post('/api/tax/household-plans')
    .send({ name: 'Null-notes', notes: 'temporary' });
  const id = create.body.plan.id;
  const res = await authed
    .patch(`/api/tax/household-plans/${id}`)
    .send({ notes: null });
  assert.equal(
    res.status,
    200,
    `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`,
  );
  assert.equal(res.body.plan.notes, null);
});

// -- Scenario link / unlink via PATCH --------------------------------------

test('PATCH /:id links scenarios via addScenarioIds', async () => {
  const create = await authed
    .post('/api/tax/household-plans')
    .send({ name: 'Link-test' });
  const planId = create.body.plan.id;

  // Create a personal scenario (auto-creates baseline for entity/year).
  const scen = await authed.post('/api/tax/personal-scenarios').send({
    entityId: personalEntityId,
    year: 2025,
    name: 'Link target',
    overrides: {},
  });
  const scenarioId = scen.body.scenario.id;

  const res = await authed
    .patch(`/api/tax/household-plans/${planId}`)
    .send({ addScenarioIds: [scenarioId] });
  assert.equal(
    res.status,
    200,
    `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`,
  );

  // Verify via GET that the scenario is now linked.
  const detail = await authed.get(`/api/tax/household-plans/${planId}`);
  assert.equal(detail.status, 200);
  assert.ok(
    detail.body.scenarios.some((s: { id: number }) => s.id === scenarioId),
    `expected scenario ${scenarioId} linked to plan ${planId}`,
  );
});

test('PATCH /:id unlinks scenarios via removeScenarioIds', async () => {
  const create = await authed
    .post('/api/tax/household-plans')
    .send({ name: 'Unlink-test' });
  const planId = create.body.plan.id;

  const scen = await authed.post('/api/tax/personal-scenarios').send({
    entityId: personalEntityId,
    year: 2025,
    name: 'Unlink target',
    overrides: {},
  });
  const scenarioId = scen.body.scenario.id;

  // Link first.
  await authed
    .patch(`/api/tax/household-plans/${planId}`)
    .send({ addScenarioIds: [scenarioId] });

  // Now unlink.
  const res = await authed
    .patch(`/api/tax/household-plans/${planId}`)
    .send({ removeScenarioIds: [scenarioId] });
  assert.equal(
    res.status,
    200,
    `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`,
  );

  const detail = await authed.get(`/api/tax/household-plans/${planId}`);
  assert.equal(detail.status, 200);
  assert.ok(
    !detail.body.scenarios.some((s: { id: number }) => s.id === scenarioId),
    `expected scenario ${scenarioId} unlinked from plan ${planId}`,
  );
});

// -- Compute happy path -----------------------------------------------------

test('GET /:id/compute returns integrated bundle with corp + personal', async () => {
  const create = await authed
    .post('/api/tax/household-plans')
    .send({ name: 'Compute-test' });
  const planId = create.body.plan.id;

  // Create a corp scenario with a salary override (routes employment income
  // into the personal entity via the integration router).
  const corpScen = await authed.post('/api/tax/corp-scenarios').send({
    entityId: corpEntityId,
    year: 2025,
    name: 'Salary heavy',
    overrides: {
      [`ownerComp.${personalEntityId}.salary`]: 60000,
      'corp.salaryPaid': 60000,
    },
  });
  assert.equal(corpScen.status, 201, JSON.stringify(corpScen.body));
  const corpScenarioId = corpScen.body.scenario.id;

  const personalScen = await authed.post('/api/tax/personal-scenarios').send({
    entityId: personalEntityId,
    year: 2025,
    name: 'Personal target',
    overrides: {},
  });
  assert.equal(personalScen.status, 201, JSON.stringify(personalScen.body));
  const personalScenarioId = personalScen.body.scenario.id;

  // Link both into the plan.
  await authed.patch(`/api/tax/household-plans/${planId}`).send({
    addScenarioIds: [corpScenarioId, personalScenarioId],
  });

  const res = await authed.get(`/api/tax/household-plans/${planId}/compute`);
  assert.equal(
    res.status,
    200,
    `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`,
  );
  assert.equal(res.body.planId, planId);
  assert.equal(res.body.corp.length, 1);
  assert.equal(res.body.personal.length, 1);
  // Router routed the salary as employment income.
  const additions = res.body.integration.byShareholder[personalEntityId];
  assert.ok(additions, 'expected router output for personal entity');
});

// -- Cross-household 403s ---------------------------------------------------

test('GET /:id for another household returns 403', async () => {
  const models = await import('../../src/models/index.js');
  const otherHousehold = await models.Household.create({ name: 'Other HH' });
  const otherPlan = await models.HouseholdPlan.create({
    householdId: otherHousehold.id,
    name: 'Theirs',
    notes: null,
  });
  const res = await authed.get(`/api/tax/household-plans/${otherPlan.id}`);
  assert.equal(
    res.status,
    403,
    `expected 403, got ${res.status}: ${JSON.stringify(res.body)}`,
  );
});

test('PATCH /:id for another household returns 403', async () => {
  const models = await import('../../src/models/index.js');
  const otherHousehold = await models.Household.create({ name: 'Other PATCH HH' });
  const otherPlan = await models.HouseholdPlan.create({
    householdId: otherHousehold.id,
    name: 'Theirs',
    notes: null,
  });
  const res = await authed
    .patch(`/api/tax/household-plans/${otherPlan.id}`)
    .send({ name: 'hijack' });
  assert.equal(
    res.status,
    403,
    `expected 403, got ${res.status}: ${JSON.stringify(res.body)}`,
  );
});

test('DELETE /:id for another household returns 403', async () => {
  const models = await import('../../src/models/index.js');
  const otherHousehold = await models.Household.create({ name: 'Other DELETE HH' });
  const otherPlan = await models.HouseholdPlan.create({
    householdId: otherHousehold.id,
    name: 'Theirs',
    notes: null,
  });
  const res = await authed.delete(`/api/tax/household-plans/${otherPlan.id}`);
  assert.equal(
    res.status,
    403,
    `expected 403, got ${res.status}: ${JSON.stringify(res.body)}`,
  );
});

test('GET /:id/compute for another household returns 403', async () => {
  const models = await import('../../src/models/index.js');
  const otherHousehold = await models.Household.create({ name: 'Other COMPUTE HH' });
  const otherPlan = await models.HouseholdPlan.create({
    householdId: otherHousehold.id,
    name: 'Theirs',
    notes: null,
  });
  const res = await authed.get(`/api/tax/household-plans/${otherPlan.id}/compute`);
  assert.equal(
    res.status,
    403,
    `expected 403, got ${res.status}: ${JSON.stringify(res.body)}`,
  );
});

// -- Listing isolation ------------------------------------------------------

test('GET / does not leak plans from other households', async () => {
  const models = await import('../../src/models/index.js');
  const otherHousehold = await models.Household.create({ name: 'Isolation HH' });
  await models.HouseholdPlan.create({
    householdId: otherHousehold.id,
    name: 'Theirs',
    notes: null,
  });
  const res = await authed.get('/api/tax/household-plans');
  assert.equal(res.status, 200);
  assert.ok(
    res.body.plans.every((p: { householdId: number }) => p.householdId === householdId),
    `leaked plans from other households: ${JSON.stringify(res.body.plans)}`,
  );
});

// -- DELETE happy path ------------------------------------------------------

test('DELETE /:id removes the plan and unlinks scenarios', async () => {
  const create = await authed
    .post('/api/tax/household-plans')
    .send({ name: 'Delete-me' });
  const planId = create.body.plan.id;

  // Link a scenario, then delete; scenario should survive with householdPlanId=null.
  const scen = await authed.post('/api/tax/personal-scenarios').send({
    entityId: personalEntityId,
    year: 2025,
    name: 'Survivor',
    overrides: {},
  });
  const scenarioId = scen.body.scenario.id;
  await authed
    .patch(`/api/tax/household-plans/${planId}`)
    .send({ addScenarioIds: [scenarioId] });

  const res = await authed.delete(`/api/tax/household-plans/${planId}`);
  assert.equal(
    res.status,
    204,
    `expected 204, got ${res.status}: ${JSON.stringify(res.body)}`,
  );

  // Plan is gone.
  const get = await authed.get(`/api/tax/household-plans/${planId}`);
  assert.equal(get.status, 404);

  // Scenario survives.
  const scenGet = await authed.get(`/api/tax/personal-scenarios/${scenarioId}`);
  assert.equal(scenGet.status, 200);
});
