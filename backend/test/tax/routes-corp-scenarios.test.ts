/**
 * Integration tests for /api/tax/corp-scenarios CRUD + fork/compute/compare
 * routes (P8a Tasks 4-5). Mirrors `routes-personal-scenarios.test.ts` but
 * seeds a corp entity and uses corp override keys.
 *
 * Same auth-setup pattern as routes-personal-scenarios.test.ts:
 * - sequelize.sync({ force: true }) instead of running migrations.
 * - Models imported BEFORE sync so all model tables are registered/created.
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
    email: `corp-scenarios-${Date.now()}@example.com`,
    displayName: 'Corp Scenarios Test',
    globalRole: 'user',
    passwordHash: password.hash,
    passwordSalt: password.salt,
    passwordParams: password.params,
  });
  const household = await models.Household.create({ name: 'Corp Scenarios HH' });
  await models.HouseholdMember.create({
    householdId: household.id,
    userId: user.id,
    role: 'owner',
  });
  const entity = await models.Entity.create({
    householdId: household.id,
    kind: 'corp',
    legalName: 'C',
    jurisdiction: 'CA-ON',
    fiscalYearEnd: '12-31',
  });
  entityId = entity.id;

  // Seed one business-revenue txn so baseline has active business income.
  const account = await models.Account.create({
    name: 'CorpChk',
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
    amount: '250000',
    currency: 'CAD',
    finalCategory: 'business_revenue',
    finalBusiness: true,
    merchantRaw: 'CUSTOMER',
    merchantClean: 'CUSTOMER',
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

test('GET /api/tax/corp-scenarios without auth returns 401', async () => {
  const res = await request(app).get(`/api/tax/corp-scenarios?entityId=${entityId}&year=2025`);
  assert.equal(res.status, 401, `expected 401, got ${res.status}: ${JSON.stringify(res.body)}`);
});

test('POST /api/tax/corp-scenarios creates a fork', async () => {
  const res = await authed.post('/api/tax/corp-scenarios').send({
    entityId,
    year: 2025,
    name: 'High revenue',
    overrides: { 'corp.activeIncome': 400000 },
  });
  assert.equal(res.status, 201, `expected 201, got ${res.status}: ${JSON.stringify(res.body)}`);
  assert.equal(res.body.scenario.name, 'High revenue');
  assert.equal(res.body.scenario.kind, 'fork');
  assert.ok(typeof res.body.scenario.parentId === 'number'); // baseline auto-created
});

test('GET /api/tax/corp-scenarios lists scenarios for entity+year', async () => {
  const res = await authed.get(`/api/tax/corp-scenarios?entityId=${entityId}&year=2025`);
  assert.equal(res.status, 200, `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
  // Baseline + the fork from previous test → at least 2 scenarios.
  assert.ok(res.body.scenarios.length >= 2);
});

test('GET /api/tax/corp-scenarios/:id returns scenario + computed return', async () => {
  const create = await authed.post('/api/tax/corp-scenarios').send({
    entityId,
    year: 2025,
    name: 'For-get-test',
    overrides: { 'corp.activeIncome': 300000 },
  });
  const id = create.body.scenario.id;
  const res = await authed.get(`/api/tax/corp-scenarios/${id}`);
  assert.equal(res.status, 200, `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
  assert.equal(res.body.scenario.id, id);
  assert.ok(res.body.computed);
  assert.ok('netTaxPayable' in res.body.computed.totals);
});

test('PATCH /api/tax/corp-scenarios/:id updates overrides', async () => {
  const create = await authed.post('/api/tax/corp-scenarios').send({
    entityId,
    year: 2025,
    name: 'PatchMe',
    overrides: { 'corp.activeIncome': 150000 },
  });
  const id = create.body.scenario.id;
  const res = await authed.patch(`/api/tax/corp-scenarios/${id}`).send({
    overrides: { 'corp.activeIncome': 220000 },
    notes: 'updated',
  });
  assert.equal(res.status, 200, `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
  assert.equal(res.body.scenario.overrides['corp.activeIncome'], 220000);
  assert.equal(res.body.scenario.notes, 'updated');
});

test('PATCH with invalid override key returns 400', async () => {
  const create = await authed.post('/api/tax/corp-scenarios').send({
    entityId,
    year: 2025,
    name: 'InvalidPatch',
    overrides: {},
  });
  const res = await authed.patch(`/api/tax/corp-scenarios/${create.body.scenario.id}`).send({
    overrides: { 'totally.fake': 1 },
  });
  assert.equal(res.status, 400, `expected 400, got ${res.status}: ${JSON.stringify(res.body)}`);
  assert.match(res.body.message, /unknown override key/i);
});

test('PATCH with a personal-only override key returns 400', async () => {
  const create = await authed.post('/api/tax/corp-scenarios').send({
    entityId,
    year: 2025,
    name: 'PersonalKeyOnCorp',
    overrides: {},
  });
  const res = await authed.patch(`/api/tax/corp-scenarios/${create.body.scenario.id}`).send({
    overrides: { 'income.employment': 80000 },
  });
  assert.equal(res.status, 400, `expected 400, got ${res.status}: ${JSON.stringify(res.body)}`);
  assert.match(res.body.message, /personal scenarios/i);
});

test('DELETE /api/tax/corp-scenarios/:id removes a fork', async () => {
  const create = await authed.post('/api/tax/corp-scenarios').send({
    entityId,
    year: 2025,
    name: 'DeleteMe',
    overrides: {},
  });
  const id = create.body.scenario.id;
  const del = await authed.delete(`/api/tax/corp-scenarios/${id}`);
  assert.equal(del.status, 204, `expected 204, got ${del.status}: ${JSON.stringify(del.body)}`);
  const get = await authed.get(`/api/tax/corp-scenarios/${id}`);
  assert.equal(get.status, 404, `expected 404, got ${get.status}: ${JSON.stringify(get.body)}`);
});

test('DELETE baseline is forbidden (409)', async () => {
  // Trigger baseline auto-create first.
  await authed.post('/api/tax/corp-scenarios').send({
    entityId,
    year: 2025,
    name: 'EnsureBaseline',
    overrides: {},
  });
  const list = await authed.get(`/api/tax/corp-scenarios?entityId=${entityId}&year=2025`);
  const baseline = list.body.scenarios.find((s: { kind: string }) => s.kind === 'baseline');
  assert.ok(baseline, 'baseline scenario should exist after at least one create');
  const res = await authed.delete(`/api/tax/corp-scenarios/${baseline.id}`);
  assert.equal(res.status, 409, `expected 409, got ${res.status}: ${JSON.stringify(res.body)}`);
});

test('DELETE scenario with children is forbidden (409)', async () => {
  const parent = await authed.post('/api/tax/corp-scenarios').send({
    entityId,
    year: 2025,
    name: 'Parent',
    overrides: {},
  });
  const fork = await authed.post('/api/tax/corp-scenarios').send({
    entityId,
    year: 2025,
    name: 'ParentChild',
    parentId: parent.body.scenario.id,
    overrides: {},
  });
  const del = await authed.delete(`/api/tax/corp-scenarios/${parent.body.scenario.id}`);
  assert.equal(del.status, 409, `expected 409, got ${del.status}: ${JSON.stringify(del.body)}`);
  // Cleanup so subsequent tests don't see stray children.
  await authed.delete(`/api/tax/corp-scenarios/${fork.body.scenario.id}`);
});

test('POST /:id/fork creates a child scenario inheriting parent overrides', async () => {
  const parent = await authed.post('/api/tax/corp-scenarios').send({
    entityId,
    year: 2025,
    name: 'ForkParent',
    overrides: { 'corp.activeIncome': 350000 },
  });
  const res = await authed.post(`/api/tax/corp-scenarios/${parent.body.scenario.id}/fork`).send({
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
  const create = await authed.post('/api/tax/corp-scenarios').send({
    entityId,
    year: 2025,
    name: 'ComputeMe',
    overrides: { 'corp.activeIncome': 280000 },
  });
  const r1 = await authed
    .post(`/api/tax/corp-scenarios/${create.body.scenario.id}/compute`)
    .send({});
  assert.equal(r1.status, 200, `expected 200, got ${r1.status}: ${JSON.stringify(r1.body)}`);
  assert.equal(r1.body.computed.cached, false);
});

test('GET /compare?ids=... returns a diff payload for N scenarios', async () => {
  const a = await authed.post('/api/tax/corp-scenarios').send({
    entityId,
    year: 2025,
    name: 'CompareA',
    overrides: { 'corp.activeIncome': 200000 },
  });
  const b = await authed.post('/api/tax/corp-scenarios').send({
    entityId,
    year: 2025,
    name: 'CompareB',
    overrides: { 'corp.activeIncome': 500000 },
  });
  const res = await authed.get(
    `/api/tax/corp-scenarios/compare?ids=${a.body.scenario.id},${b.body.scenario.id}`,
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
    kind: 'corp',
    legalName: 'Other C',
    jurisdiction: 'CA-ON',
    fiscalYearEnd: '12-31',
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
  const mine = await authed.post('/api/tax/corp-scenarios').send({
    entityId,
    year: 2025,
    name: 'Mine',
    overrides: {},
  });
  const res = await authed.get(
    `/api/tax/corp-scenarios/compare?ids=${mine.body.scenario.id},${otherScenario.id}`,
  );
  assert.equal(res.status, 403, `expected 403, got ${res.status}: ${JSON.stringify(res.body)}`);
});
