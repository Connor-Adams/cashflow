/**
 * Integration tests for /api/tax/personal-scenarios CRUD routes (Task 6, P7).
 *
 * Mirrors the auth-setup pattern from backend/test/tax/routes-reconciliation.test.ts:
 * - sequelize.sync({ force: true }) instead of running migrations (one P6
 *   migration uses Postgres-only ALTER COLUMN syntax that SQLite can't parse).
 * - Models imported BEFORE sync so all model tables are registered/created (P6
 *   lesson).
 * - Direct User + Household + HouseholdMember + Session creation, then
 *   request.agent(app) with cookie injection.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import crypto from 'crypto';

let app: import('express').Express;
let authed: ReturnType<typeof request.agent>;
let entityId: number;

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
    email: `scenarios-${Date.now()}@example.com`,
    displayName: 'Scenarios Test',
    globalRole: 'user',
    passwordHash: password.hash,
    passwordSalt: password.salt,
    passwordParams: password.params,
  });
  const household = await models.Household.create({ name: 'Scenarios HH' });
  await models.HouseholdMember.create({
    householdId: household.id,
    userId: user.id,
    role: 'owner',
  });
  const entity = await models.Entity.create({
    householdId: household.id,
    kind: 'personal',
    legalName: 'P',
    jurisdiction: 'CA-ON',
    fiscalYearEnd: null,
  });
  entityId = entity.id;

  // Seed one txn so baseline has employment income.
  const account = await models.Account.create({
    name: 'Chk',
    householdId: household.id,
    accountType: 'checking',
    entityId: entity.id,
    taxStatus: 'non_registered',
    defaultCurrency: 'CAD',
  } as never);
  await models.Transaction.create({
    accountId: account.id,
    householdId: household.id,
    entityId: entity.id,
    date: '2025-03-15',
    amount: '80000',
    currency: 'CAD',
    finalCategory: 'employment_income',
    merchantRaw: 'E',
    merchantClean: 'E',
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

test('GET /api/tax/personal-scenarios without auth returns 401', async () => {
  const res = await request(app).get(`/api/tax/personal-scenarios?entityId=${entityId}&year=2025`);
  assert.equal(res.status, 401, `expected 401, got ${res.status}: ${JSON.stringify(res.body)}`);
});

test('POST /api/tax/personal-scenarios creates a fork', async () => {
  const res = await authed.post('/api/tax/personal-scenarios').send({
    entityId,
    year: 2025,
    name: 'High salary',
    overrides: { 'income.employment': 120000 },
  });
  assert.equal(res.status, 201, `expected 201, got ${res.status}: ${JSON.stringify(res.body)}`);
  assert.equal(res.body.scenario.name, 'High salary');
  assert.equal(res.body.scenario.kind, 'fork');
  assert.ok(typeof res.body.scenario.parentId === 'number'); // baseline auto-created
});

test('GET /api/tax/personal-scenarios lists scenarios for entity+year', async () => {
  const res = await authed.get(`/api/tax/personal-scenarios?entityId=${entityId}&year=2025`);
  assert.equal(res.status, 200, `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
  // Baseline + the fork from previous test → at least 2 scenarios.
  assert.ok(res.body.scenarios.length >= 2);
});

test('GET /api/tax/personal-scenarios/:id returns scenario + computed return', async () => {
  const create = await authed.post('/api/tax/personal-scenarios').send({
    entityId,
    year: 2025,
    name: 'For-get-test',
    overrides: { 'income.employment': 60000 },
  });
  const id = create.body.scenario.id;
  const res = await authed.get(`/api/tax/personal-scenarios/${id}`);
  assert.equal(res.status, 200, `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
  assert.equal(res.body.scenario.id, id);
  assert.ok(res.body.computed);
  assert.ok('totalPayable' in res.body.computed.totals);
});

test('PATCH /api/tax/personal-scenarios/:id updates overrides', async () => {
  const create = await authed.post('/api/tax/personal-scenarios').send({
    entityId,
    year: 2025,
    name: 'PatchMe',
    overrides: { 'income.employment': 50000 },
  });
  const id = create.body.scenario.id;
  const res = await authed.patch(`/api/tax/personal-scenarios/${id}`).send({
    overrides: { 'income.employment': 75000 },
    notes: 'updated',
  });
  assert.equal(res.status, 200, `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
  assert.equal(res.body.scenario.overrides['income.employment'], 75000);
  assert.equal(res.body.scenario.notes, 'updated');
});

test('PATCH with invalid override key returns 400', async () => {
  const create = await authed.post('/api/tax/personal-scenarios').send({
    entityId,
    year: 2025,
    name: 'InvalidPatch',
    overrides: {},
  });
  const res = await authed.patch(`/api/tax/personal-scenarios/${create.body.scenario.id}`).send({
    overrides: { 'totally.fake': 1 },
  });
  assert.equal(res.status, 400, `expected 400, got ${res.status}: ${JSON.stringify(res.body)}`);
  assert.match(res.body.message, /unknown override key/i);
});

test('DELETE /api/tax/personal-scenarios/:id removes a fork', async () => {
  const create = await authed.post('/api/tax/personal-scenarios').send({
    entityId,
    year: 2025,
    name: 'DeleteMe',
    overrides: {},
  });
  const id = create.body.scenario.id;
  const del = await authed.delete(`/api/tax/personal-scenarios/${id}`);
  assert.equal(del.status, 204, `expected 204, got ${del.status}: ${JSON.stringify(del.body)}`);
  const get = await authed.get(`/api/tax/personal-scenarios/${id}`);
  assert.equal(get.status, 404, `expected 404, got ${get.status}: ${JSON.stringify(get.body)}`);
});

test('DELETE baseline is forbidden (409)', async () => {
  // Trigger baseline auto-create first.
  await authed.post('/api/tax/personal-scenarios').send({
    entityId,
    year: 2025,
    name: 'EnsureBaseline',
    overrides: {},
  });
  const list = await authed.get(`/api/tax/personal-scenarios?entityId=${entityId}&year=2025`);
  const baseline = list.body.scenarios.find((s: { kind: string }) => s.kind === 'baseline');
  assert.ok(baseline, 'baseline scenario should exist after at least one create');
  const res = await authed.delete(`/api/tax/personal-scenarios/${baseline.id}`);
  assert.equal(res.status, 409, `expected 409, got ${res.status}: ${JSON.stringify(res.body)}`);
});

test('DELETE scenario with children is forbidden (409)', async () => {
  const parent = await authed.post('/api/tax/personal-scenarios').send({
    entityId,
    year: 2025,
    name: 'Parent',
    overrides: {},
  });
  const fork = await authed.post('/api/tax/personal-scenarios').send({
    entityId,
    year: 2025,
    name: 'ParentChild',
    parentId: parent.body.scenario.id,
    overrides: {},
  });
  const del = await authed.delete(`/api/tax/personal-scenarios/${parent.body.scenario.id}`);
  assert.equal(del.status, 409, `expected 409, got ${del.status}: ${JSON.stringify(del.body)}`);
  // Cleanup so subsequent tests don't see stray children.
  await authed.delete(`/api/tax/personal-scenarios/${fork.body.scenario.id}`);
});

test('POST /:id/fork creates a child scenario inheriting parent overrides', async () => {
  const parent = await authed.post('/api/tax/personal-scenarios').send({
    entityId,
    year: 2025,
    name: 'ForkParent',
    overrides: { 'income.employment': 85000 },
  });
  const res = await authed.post(`/api/tax/personal-scenarios/${parent.body.scenario.id}/fork`).send({
    name: 'ForkChild',
  });
  assert.equal(res.status, 201, `expected 201, got ${res.status}: ${JSON.stringify(res.body)}`);
  assert.equal(res.body.scenario.parentId, parent.body.scenario.id);
  assert.equal(res.body.scenario.name, 'ForkChild');
  // Child starts empty — inheritance is via ancestry resolution at compute
  // time, not by duplicating the parent's override map.
  assert.deepEqual(res.body.scenario.overrides, {});
});

test('POST /:id/compute returns fresh computation (bypass cache)', async () => {
  const create = await authed.post('/api/tax/personal-scenarios').send({
    entityId,
    year: 2025,
    name: 'ComputeMe',
    overrides: { 'income.employment': 70000 },
  });
  const r1 = await authed
    .post(`/api/tax/personal-scenarios/${create.body.scenario.id}/compute`)
    .send({});
  assert.equal(r1.status, 200, `expected 200, got ${r1.status}: ${JSON.stringify(r1.body)}`);
  assert.equal(r1.body.computed.cached, false);
});

test('GET /compare?ids=... returns a diff payload for N scenarios', async () => {
  const a = await authed.post('/api/tax/personal-scenarios').send({
    entityId,
    year: 2025,
    name: 'CompareA',
    overrides: { 'income.employment': 60000 },
  });
  const b = await authed.post('/api/tax/personal-scenarios').send({
    entityId,
    year: 2025,
    name: 'CompareB',
    overrides: { 'income.employment': 90000 },
  });
  const res = await authed.get(
    `/api/tax/personal-scenarios/compare?ids=${a.body.scenario.id},${b.body.scenario.id}`,
  );
  assert.equal(res.status, 200, `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
  assert.equal(res.body.scenarios.length, 2);
  assert.ok(res.body.scenarios[0].computed);
  assert.ok(res.body.scenarios[1].computed);
});

test('GET /compare with mixed ownership returns 403', async () => {
  // Create a scenario in another household to attempt a cross-household leak.
  const models = await import('../../src/models/index.js');
  const otherHousehold = await models.Household.create({ name: 'Other' });
  const otherEntity = await models.Entity.create({
    householdId: otherHousehold.id,
    kind: 'personal',
    legalName: 'Other P',
    jurisdiction: 'CA-ON',
    fiscalYearEnd: null,
  });
  const otherScenario = await models.Scenario.create({
    parentId: null,
    householdPlanId: null,
    entityId: otherEntity.id,
    year: 2025,
    name: 'Other',
    kind: 'baseline',
    overrides: {},
    assumptions: {},
    nextYearId: null,
    notes: null,
  });
  const mine = await authed.post('/api/tax/personal-scenarios').send({
    entityId,
    year: 2025,
    name: 'Mine',
    overrides: {},
  });
  const res = await authed.get(
    `/api/tax/personal-scenarios/compare?ids=${mine.body.scenario.id},${otherScenario.id}`,
  );
  assert.equal(res.status, 403, `expected 403, got ${res.status}: ${JSON.stringify(res.body)}`);
});

// ----- POST /:id/project-next-year (P9 Task 4) -----
//
// Each project-next-year test seeds its OWN entity (in the shared household)
// so the per-entity `kind=projection_root` idempotency check doesn't collide
// across tests. Year is fixed at 2025 because only rate tables 2024-2026 are
// encoded — projecting to 2026 stays inside the encoded range.

async function seedFreshPersonalEntity(legalName: string) {
  const models = await import('../../src/models/index.js');
  const householdMember = await models.HouseholdMember.findOne({});
  assert.ok(householdMember);
  return models.Entity.create({
    householdId: householdMember.householdId,
    kind: 'personal',
    legalName,
    jurisdiction: 'CA-ON',
    fiscalYearEnd: null,
  });
}

test('POST /:id/project-next-year without auth returns 401', async () => {
  const res = await request(app).post('/api/tax/personal-scenarios/1/project-next-year').send({});
  assert.equal(res.status, 401, `expected 401, got ${res.status}: ${JSON.stringify(res.body)}`);
});

test('POST /:id/project-next-year creates a projection_root for year+1', async () => {
  const models = await import('../../src/models/index.js');
  const fresh = await seedFreshPersonalEntity('ProjPersonal1');
  const parent = await authed.post('/api/tax/personal-scenarios').send({
    entityId: fresh.id,
    year: 2025,
    name: 'ProjBaseParent',
    overrides: { 'income.employment': 90000 },
  });
  const parentId = parent.body.scenario.id;
  const res = await authed
    .post(`/api/tax/personal-scenarios/${parentId}/project-next-year`)
    .send({});
  assert.equal(res.status, 201, `expected 201, got ${res.status}: ${JSON.stringify(res.body)}`);
  assert.equal(res.body.scenario.kind, 'projection_root');
  assert.equal(res.body.scenario.year, 2026);
  assert.equal(res.body.scenario.parentId, parentId);
  assert.equal(res.body.scenario.name, 'Projection 2026');
  // Parent should now point forward via next_year_id. Re-read directly from
  // the DB to avoid the GET endpoint's eager computeScenario (which doesn't
  // matter here — we're checking the link, not the engine).
  const reloaded = await models.Scenario.findByPk(parentId);
  assert.ok(reloaded);
  assert.equal(reloaded.nextYearId, res.body.scenario.id);
});

test('POST /:id/project-next-year is idempotent: second call returns 409 with existing', async () => {
  const fresh = await seedFreshPersonalEntity('ProjPersonal2');
  const parent = await authed.post('/api/tax/personal-scenarios').send({
    entityId: fresh.id,
    year: 2025,
    name: 'ProjBaseParent',
    overrides: {},
  });
  const parentId = parent.body.scenario.id;
  const first = await authed
    .post(`/api/tax/personal-scenarios/${parentId}/project-next-year`)
    .send({});
  assert.equal(first.status, 201);
  const second = await authed
    .post(`/api/tax/personal-scenarios/${parentId}/project-next-year`)
    .send({});
  assert.equal(second.status, 409, `expected 409, got ${second.status}: ${JSON.stringify(second.body)}`);
  assert.equal(second.body.error, 'projection_already_exists');
  assert.equal(second.body.scenario.id, first.body.scenario.id);
});

test('POST /:id/project-next-year persists custom assumptions and name', async () => {
  const fresh = await seedFreshPersonalEntity('ProjPersonal3');
  const parent = await authed.post('/api/tax/personal-scenarios').send({
    entityId: fresh.id,
    year: 2025,
    name: 'ProjBaseParent',
    overrides: {},
  });
  const res = await authed
    .post(`/api/tax/personal-scenarios/${parent.body.scenario.id}/project-next-year`)
    .send({
      name: 'Aggressive 2026',
      assumptions: { inflation: 0.04, investmentReturn: 0.07 },
    });
  assert.equal(res.status, 201, `expected 201, got ${res.status}: ${JSON.stringify(res.body)}`);
  assert.equal(res.body.scenario.name, 'Aggressive 2026');
  assert.equal(res.body.scenario.assumptions.inflation, 0.04);
  assert.equal(res.body.scenario.assumptions.investmentReturn, 0.07);
});

test('POST /:id/project-next-year inherits householdPlanId from parent', async () => {
  // Attach the parent to a plan so the projection should inherit the link.
  const models = await import('../../src/models/index.js');
  const fresh = await seedFreshPersonalEntity('ProjPersonal4');
  const parent = await authed.post('/api/tax/personal-scenarios').send({
    entityId: fresh.id,
    year: 2025,
    name: 'ProjBaseParent',
    overrides: {},
  });
  const plan = await models.HouseholdPlan.create({
    householdId: fresh.householdId,
    name: 'PlanInheritTest',
  } as never);
  await models.Scenario.update(
    { householdPlanId: plan.id },
    { where: { id: parent.body.scenario.id } },
  );
  const res = await authed
    .post(`/api/tax/personal-scenarios/${parent.body.scenario.id}/project-next-year`)
    .send({});
  assert.equal(res.status, 201, `expected 201, got ${res.status}: ${JSON.stringify(res.body)}`);
  assert.equal(res.body.scenario.householdPlanId, plan.id);
});

test('POST /:id/project-next-year on a projection_root returns 400', async () => {
  const fresh = await seedFreshPersonalEntity('ProjPersonal5');
  const parent = await authed.post('/api/tax/personal-scenarios').send({
    entityId: fresh.id,
    year: 2025,
    name: 'ProjBaseParent',
    overrides: {},
  });
  const proj = await authed
    .post(`/api/tax/personal-scenarios/${parent.body.scenario.id}/project-next-year`)
    .send({});
  assert.equal(proj.status, 201);
  const double = await authed
    .post(`/api/tax/personal-scenarios/${proj.body.scenario.id}/project-next-year`)
    .send({});
  assert.equal(double.status, 400, `expected 400, got ${double.status}: ${JSON.stringify(double.body)}`);
  assert.equal(double.body.error, 'already_projection_root');
});

test('POST /:id/project-next-year on a cross-household scenario returns 403', async () => {
  const models = await import('../../src/models/index.js');
  const otherHousehold = await models.Household.create({ name: 'OtherProj' });
  const otherEntity = await models.Entity.create({
    householdId: otherHousehold.id,
    kind: 'personal',
    legalName: 'Other P',
    jurisdiction: 'CA-ON',
    fiscalYearEnd: null,
  });
  const otherScenario = await models.Scenario.create({
    parentId: null,
    householdPlanId: null,
    entityId: otherEntity.id,
    year: 2025,
    name: 'OtherBaseline',
    kind: 'baseline',
    overrides: {},
    assumptions: {},
    nextYearId: null,
    notes: null,
  });
  const res = await authed
    .post(`/api/tax/personal-scenarios/${otherScenario.id}/project-next-year`)
    .send({});
  assert.equal(res.status, 403, `expected 403, got ${res.status}: ${JSON.stringify(res.body)}`);
});
