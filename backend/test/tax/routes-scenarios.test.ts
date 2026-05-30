/**
 * Integration tests for the unified /api/tax/scenarios/:kind route (issue #377).
 *
 * tax-personal-scenarios.ts + tax-corp-scenarios.ts were folded into a single
 * route file that discriminates on the `:kind` path segment (personal|corp) and
 * selects the override validator + resolve/compute layer via a lookup table.
 *
 * This test exercises BOTH kinds through the unified route to prove the fold
 * preserved per-kind behavior (the AC requirement), plus the cross-cutting
 * concerns: unknown-kind 404, the old paths now returning 410 Gone, and the
 * full 10-endpoint CRUD surface.
 *
 * Same auth-setup pattern as the old routes-personal-scenarios.test.ts:
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
    email: `unified-scenarios-${Date.now()}@example.com`,
    displayName: 'Unified Scenarios Test',
    globalRole: 'user',
    passwordHash: password.hash,
    passwordSalt: password.salt,
    passwordParams: password.params,
  });
  const household = await models.Household.create({ name: 'Unified Scenarios HH' });
  householdId = household.id;
  await models.HouseholdMember.create({
    householdId: household.id,
    userId: user.id,
    role: 'owner',
  });

  // Personal entity + an employment-income txn so its baseline computes.
  const personalEntity = await models.Entity.create({
    householdId: household.id,
    kind: 'personal',
    legalName: 'P',
    jurisdiction: 'CA-ON',
    fiscalYearEnd: null,
  });
  personalEntityId = personalEntity.id;
  const personalAccount = await models.Account.create({
    name: 'Chk',
    householdId: household.id,
    accountType: 'checking',
    entityId: personalEntity.id,
    taxStatus: 'non_registered',
    defaultCurrency: 'CAD',
  } as never);
  await models.Transaction.create({
    accountId: personalAccount.id,
    householdId: household.id,
    entityId: personalEntity.id,
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

  // Corp entity + a business-revenue txn so its baseline computes.
  const corpEntity = await models.Entity.create({
    householdId: household.id,
    kind: 'corp',
    legalName: 'C',
    jurisdiction: 'CA-ON',
    fiscalYearEnd: '12-31',
  });
  corpEntityId = corpEntity.id;
  const corpAccount = await models.Account.create({
    name: 'CorpChk',
    householdId: household.id,
    accountType: 'checking',
    entityId: corpEntity.id,
    taxStatus: 'non_registered',
    defaultCurrency: 'CAD',
  } as never);
  await models.Transaction.create({
    accountId: corpAccount.id,
    householdId: household.id,
    entityId: corpEntity.id,
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

// Per-kind fixtures so each parametrized block runs against the right entity +
// override key + computed-total assertions.
const KIND_FIXTURES = {
  personal: {
    kind: 'personal' as const,
    sampleOverride: { 'income.employment': 120000 },
    patchedOverride: { 'income.employment': 75000 },
    patchedOverrideKey: 'income.employment',
    patchedOverrideValue: 75000,
    totalsKey: 'totalPayable',
    crossKindOverride: { 'corp.activeIncome': 400000 }, // corp key rejected on personal
    crossKindRegex: /corp scenarios/i,
  },
  corp: {
    kind: 'corp' as const,
    sampleOverride: { 'corp.activeIncome': 400000 },
    patchedOverride: { 'corp.activeIncome': 220000 },
    patchedOverrideKey: 'corp.activeIncome',
    patchedOverrideValue: 220000,
    totalsKey: 'netTaxPayable',
    crossKindOverride: { 'income.employment': 80000 }, // personal key rejected on corp
    crossKindRegex: /personal scenarios/i,
  },
};

function entityIdFor(kind: 'personal' | 'corp'): number {
  return kind === 'personal' ? personalEntityId : corpEntityId;
}

// ----- Cross-cutting: auth, unknown kind, old paths gone -----

test('GET /api/tax/scenarios/personal without auth returns 401', async () => {
  const res = await request(app).get(
    `/api/tax/scenarios/personal?entityId=${personalEntityId}&year=2025`,
  );
  assert.equal(res.status, 401, `expected 401, got ${res.status}: ${JSON.stringify(res.body)}`);
});

test('GET /api/tax/scenarios/corp without auth returns 401', async () => {
  const res = await request(app).get(
    `/api/tax/scenarios/corp?entityId=${corpEntityId}&year=2025`,
  );
  assert.equal(res.status, 401, `expected 401, got ${res.status}: ${JSON.stringify(res.body)}`);
});

test('GET /api/tax/scenarios/:kind with an unknown kind returns 404', async () => {
  const res = await authed.get('/api/tax/scenarios/bogus?entityId=1&year=2025');
  assert.equal(res.status, 404, `expected 404, got ${res.status}: ${JSON.stringify(res.body)}`);
  assert.equal(res.body.error, 'unknown_scenario_kind');
});

test('old /api/tax/personal-scenarios path returns 410 Gone', async () => {
  const res = await authed.get(`/api/tax/personal-scenarios?entityId=${personalEntityId}&year=2025`);
  assert.equal(res.status, 410, `expected 410, got ${res.status}: ${JSON.stringify(res.body)}`);
  assert.equal(res.body.error, 'gone');
});

test('old /api/tax/corp-scenarios path returns 410 Gone', async () => {
  const res = await authed.get(`/api/tax/corp-scenarios?entityId=${corpEntityId}&year=2025`);
  assert.equal(res.status, 410, `expected 410, got ${res.status}: ${JSON.stringify(res.body)}`);
  assert.equal(res.body.error, 'gone');
});

// ----- Parametrized CRUD + fork/compute/compare over BOTH kinds -----

for (const fx of Object.values(KIND_FIXTURES)) {
  const base = `/api/tax/scenarios/${fx.kind}`;

  test(`[${fx.kind}] POST ${base} creates a fork (baseline auto-created)`, async () => {
    const res = await authed.post(base).send({
      entityId: entityIdFor(fx.kind),
      year: 2025,
      name: 'High',
      overrides: fx.sampleOverride,
    });
    assert.equal(res.status, 201, `expected 201, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.scenario.name, 'High');
    assert.equal(res.body.scenario.kind, 'fork');
    assert.ok(typeof res.body.scenario.parentId === 'number');
  });

  test(`[${fx.kind}] GET ${base} lists scenarios for entity+year`, async () => {
    const res = await authed.get(`${base}?entityId=${entityIdFor(fx.kind)}&year=2025`);
    assert.equal(res.status, 200, `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert.ok(res.body.scenarios.length >= 2); // baseline + fork
  });

  test(`[${fx.kind}] GET ${base}/:id returns scenario + computed return`, async () => {
    const create = await authed.post(base).send({
      entityId: entityIdFor(fx.kind),
      year: 2025,
      name: 'ForGet',
      overrides: fx.sampleOverride,
    });
    const id = create.body.scenario.id;
    const res = await authed.get(`${base}/${id}`);
    assert.equal(res.status, 200, `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.scenario.id, id);
    assert.ok(res.body.computed);
    assert.ok(fx.totalsKey in res.body.computed.totals, `expected ${fx.totalsKey} in totals`);
  });

  test(`[${fx.kind}] PATCH ${base}/:id updates overrides`, async () => {
    const create = await authed.post(base).send({
      entityId: entityIdFor(fx.kind),
      year: 2025,
      name: 'PatchMe',
      overrides: fx.sampleOverride,
    });
    const res = await authed.patch(`${base}/${create.body.scenario.id}`).send({
      overrides: fx.patchedOverride,
      notes: 'updated',
    });
    assert.equal(res.status, 200, `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.scenario.overrides[fx.patchedOverrideKey], fx.patchedOverrideValue);
    assert.equal(res.body.scenario.notes, 'updated');
  });

  test(`[${fx.kind}] PATCH with an unknown override key returns 400`, async () => {
    const create = await authed.post(base).send({
      entityId: entityIdFor(fx.kind),
      year: 2025,
      name: 'InvalidPatch',
      overrides: {},
    });
    const res = await authed.patch(`${base}/${create.body.scenario.id}`).send({
      overrides: { 'totally.fake': 1 },
    });
    assert.equal(res.status, 400, `expected 400, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert.match(res.body.message, /unknown override key/i);
  });

  test(`[${fx.kind}] PATCH with the OTHER kind's override key returns 400`, async () => {
    // Proves the per-kind validator is selected via the lookup table: a corp
    // key on a personal scenario (and vice versa) must be rejected.
    const create = await authed.post(base).send({
      entityId: entityIdFor(fx.kind),
      year: 2025,
      name: 'CrossKindPatch',
      overrides: {},
    });
    const res = await authed.patch(`${base}/${create.body.scenario.id}`).send({
      overrides: fx.crossKindOverride,
    });
    assert.equal(res.status, 400, `expected 400, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert.match(res.body.message, fx.crossKindRegex);
  });

  test(`[${fx.kind}] POST ${base} with the OTHER kind's override key returns 400`, async () => {
    const res = await authed.post(base).send({
      entityId: entityIdFor(fx.kind),
      year: 2025,
      name: 'CrossKindCreate',
      overrides: fx.crossKindOverride,
    });
    assert.equal(res.status, 400, `expected 400, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.error, 'invalid_overrides');
  });

  test(`[${fx.kind}] DELETE ${base}/:id removes a fork`, async () => {
    const create = await authed.post(base).send({
      entityId: entityIdFor(fx.kind),
      year: 2025,
      name: 'DeleteMe',
      overrides: {},
    });
    const id = create.body.scenario.id;
    const del = await authed.delete(`${base}/${id}`);
    assert.equal(del.status, 204, `expected 204, got ${del.status}: ${JSON.stringify(del.body)}`);
    const get = await authed.get(`${base}/${id}`);
    assert.equal(get.status, 404, `expected 404, got ${get.status}: ${JSON.stringify(get.body)}`);
  });

  test(`[${fx.kind}] DELETE baseline is forbidden (409)`, async () => {
    await authed.post(base).send({
      entityId: entityIdFor(fx.kind),
      year: 2025,
      name: 'EnsureBaseline',
      overrides: {},
    });
    const list = await authed.get(`${base}?entityId=${entityIdFor(fx.kind)}&year=2025`);
    const baseline = list.body.scenarios.find((s: { kind: string }) => s.kind === 'baseline');
    assert.ok(baseline, 'baseline scenario should exist after at least one create');
    const res = await authed.delete(`${base}/${baseline.id}`);
    assert.equal(res.status, 409, `expected 409, got ${res.status}: ${JSON.stringify(res.body)}`);
  });

  test(`[${fx.kind}] POST ${base}/:id/fork creates an empty child`, async () => {
    const parent = await authed.post(base).send({
      entityId: entityIdFor(fx.kind),
      year: 2025,
      name: 'ForkParent',
      overrides: fx.sampleOverride,
    });
    const res = await authed.post(`${base}/${parent.body.scenario.id}/fork`).send({ name: 'ForkChild' });
    assert.equal(res.status, 201, `expected 201, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.scenario.parentId, parent.body.scenario.id);
    assert.equal(res.body.scenario.name, 'ForkChild');
    assert.deepEqual(res.body.scenario.overrides, {});
  });

  test(`[${fx.kind}] POST ${base}/:id/compute bypasses cache`, async () => {
    const create = await authed.post(base).send({
      entityId: entityIdFor(fx.kind),
      year: 2025,
      name: 'ComputeMe',
      overrides: fx.sampleOverride,
    });
    const r1 = await authed.post(`${base}/${create.body.scenario.id}/compute`).send({});
    assert.equal(r1.status, 200, `expected 200, got ${r1.status}: ${JSON.stringify(r1.body)}`);
    assert.equal(r1.body.computed.cached, false);
  });

  test(`[${fx.kind}] GET ${base}/compare returns a diff payload for N scenarios`, async () => {
    const a = await authed.post(base).send({
      entityId: entityIdFor(fx.kind),
      year: 2025,
      name: 'CompareA',
      overrides: fx.sampleOverride,
    });
    const b = await authed.post(base).send({
      entityId: entityIdFor(fx.kind),
      year: 2025,
      name: 'CompareB',
      overrides: fx.sampleOverride,
    });
    const res = await authed.get(
      `${base}/compare?ids=${a.body.scenario.id},${b.body.scenario.id}`,
    );
    assert.equal(res.status, 200, `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.scenarios.length, 2);
    assert.ok(res.body.scenarios[0].computed);
    assert.ok(res.body.scenarios[1].computed);
  });
}

// ----- corp-specific entity-kind guard (personal route is intentionally lax) -----

test('[corp] POST /api/tax/scenarios/corp on a personal entity returns 400 not_corp', async () => {
  const res = await authed.post('/api/tax/scenarios/corp').send({
    entityId: personalEntityId,
    year: 2025,
    name: 'WrongKind',
    overrides: {},
  });
  assert.equal(res.status, 400, `expected 400, got ${res.status}: ${JSON.stringify(res.body)}`);
  assert.equal(res.body.error, 'not_corp');
});

test('[corp] GET /api/tax/scenarios/corp/:id on a personal scenario returns 400 not_corp', async () => {
  // Create a personal scenario, then attempt to fetch it via the corp route.
  const personal = await authed.post('/api/tax/scenarios/personal').send({
    entityId: personalEntityId,
    year: 2025,
    name: 'PersonalForCorpGuard',
    overrides: {},
  });
  const res = await authed.get(`/api/tax/scenarios/corp/${personal.body.scenario.id}`);
  assert.equal(res.status, 400, `expected 400, got ${res.status}: ${JSON.stringify(res.body)}`);
  assert.equal(res.body.error, 'not_corp');
});

// ----- project-next-year + chain over BOTH kinds (year-N anchor walk) -----
//
// Each test seeds its OWN entity so the per-entity projection_root idempotency
// check + chain state don't collide. Years stay inside encoded rate tables
// (2024-2026).

async function seedFreshEntity(kind: 'personal' | 'corp', legalName: string) {
  const models = await import('../../src/models/index.js');
  return models.Entity.create({
    householdId,
    kind,
    legalName,
    jurisdiction: 'CA-ON',
    fiscalYearEnd: kind === 'corp' ? '12-31' : null,
  });
}

for (const fx of Object.values(KIND_FIXTURES)) {
  const base = `/api/tax/scenarios/${fx.kind}`;

  test(`[${fx.kind}] POST ${base}/:id/project-next-year creates a projection_root for year+1`, async () => {
    const models = await import('../../src/models/index.js');
    const fresh = await seedFreshEntity(fx.kind, `Proj-${fx.kind}-1`);
    const parent = await authed.post(base).send({
      entityId: fresh.id,
      year: 2025,
      name: 'ProjBase',
      overrides: fx.sampleOverride,
    });
    const parentId = parent.body.scenario.id;
    const res = await authed.post(`${base}/${parentId}/project-next-year`).send({});
    assert.equal(res.status, 201, `expected 201, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.scenario.kind, 'projection_root');
    assert.equal(res.body.scenario.year, 2026);
    assert.equal(res.body.scenario.parentId, parentId);
    const reloaded = await models.Scenario.findByPk(parentId);
    assert.ok(reloaded);
    assert.equal(reloaded.nextYearId, res.body.scenario.id);
  });

  test(`[${fx.kind}] POST ${base}/:id/project-next-year is idempotent (409 with existing)`, async () => {
    const fresh = await seedFreshEntity(fx.kind, `Proj-${fx.kind}-2`);
    const parent = await authed.post(base).send({
      entityId: fresh.id,
      year: 2025,
      name: 'ProjBase',
      overrides: {},
    });
    const parentId = parent.body.scenario.id;
    const first = await authed.post(`${base}/${parentId}/project-next-year`).send({});
    assert.equal(first.status, 201);
    const second = await authed.post(`${base}/${parentId}/project-next-year`).send({});
    assert.equal(second.status, 409, `expected 409, got ${second.status}: ${JSON.stringify(second.body)}`);
    assert.equal(second.body.error, 'projection_already_exists');
    assert.equal(second.body.scenario.id, first.body.scenario.id);
  });

  test(`[${fx.kind}] GET ${base}/:id/chain returns 2 entries after one project-next-year`, async () => {
    const fresh = await seedFreshEntity(fx.kind, `Chain-${fx.kind}-1`);
    const parent = await authed.post(base).send({
      entityId: fresh.id,
      year: 2025,
      name: 'ChainParent',
      overrides: fx.sampleOverride,
    });
    const proj = await authed.post(`${base}/${parent.body.scenario.id}/project-next-year`).send({});
    assert.equal(proj.status, 201);
    const res = await authed.get(`${base}/${parent.body.scenario.id}/chain`);
    assert.equal(res.status, 200, `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.chain.length, 2);
    const years = res.body.chain.map((e: { scenario: { year: number } }) => e.scenario.year);
    assert.deepEqual(years, [2025, 2026]);
    assert.ok(res.body.chain[0].computed);
    assert.ok(res.body.chain[1].computed);
  });

  test(`[${fx.kind}] GET ${base}/:id/chain returns 404 on unknown id`, async () => {
    const res = await authed.get(`${base}/9999999/chain`);
    assert.equal(res.status, 404, `expected 404, got ${res.status}: ${JSON.stringify(res.body)}`);
  });
}
