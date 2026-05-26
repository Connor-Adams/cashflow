/**
 * P9 Task 11 — End-to-end integration test for multi-year scenario chains.
 *
 * Covers the full P9 flow:
 *   1. Seed personal entity with year-2024 employment income (rate tables only
 *      encode 2024-2026; starting at 2024 keeps year+2 = 2026 in range).
 *   2. Create the 2024 baseline via the standard POST flow (auto-creates
 *      baseline + a 2024 fork).
 *   3. POST /:id/project-next-year to create the 2025 projection_root chained
 *      off the 2024 anchor.
 *   4. Verify GET /:id/chain returns both scenarios in year order.
 *   5. Create the 2026 projection_root directly via Scenario.create +
 *      Scenario.update(nextYearId) — the /project-next-year route rejects
 *      projection_root parents (Task 4 design + Task 5 implementer report).
 *   6. Verify GET /:id/chain returns all three scenarios in year order.
 *   7. Compute the 2026 scenario via computeScenario → succeeds; resolve its
 *      facts and verify ageAtYearEnd is +2 vs the 2024 baseline.
 *   8. Fork the 2025 projection_root with an income override → resolve still
 *      works (Task 3 resolver dispatch hands off to projectFromPrevYear for
 *      projection_root roots, then applyOverrides layers the override on top).
 *
 * Bootstrap pattern mirrors routes-personal-scenarios.test.ts (sync({force:true})
 * + models BEFORE sync + supertest agent with session cookie).
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import crypto from 'crypto';

let app: import('express').Express;
let authed: ReturnType<typeof request.agent>;
let entityId: number;
let userDob: string;

before(async () => {
  process.env.NODE_ENV = 'test';
  const { sequelize } = await import('../../../src/db.js');
  // Import models BEFORE sync so all model tables are registered/created.
  const models = await import('../../../src/models/index.js');
  await sequelize.sync({ force: true });

  const mod = await import('../../../src/app.js');
  app = mod.default;

  const { hashPassword, hashToken } = await import('../../../src/auth/password.js');

  const password = await hashPassword('password123');
  // DOB chosen so ageAtYearEnd is non-zero across 2024-2026, making the
  // "+2 from baseline" assertion meaningful (1990 → age 34 in 2024, 36 in 2026).
  userDob = '1990-01-15';
  const user = await models.User.create({
    email: `multi-year-e2e-${Date.now()}@example.com`,
    displayName: 'Multi-Year E2E',
    globalRole: 'user',
    passwordHash: password.hash,
    passwordSalt: password.salt,
    passwordParams: password.params,
    dob: userDob,
  });
  const household = await models.Household.create({ name: 'E2E HH' });
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

  // Seed a 2024 employment_income txn so the baseline has actuals to roll forward.
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
    date: '2024-03-15',
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
  const { sequelize } = await import('../../../src/db.js');
  await sequelize.close();
});

test('full multi-year chain: 2024 baseline → 2025 projection → 2026 projection (direct), with fork on 2025', async () => {
  const models = await import('../../../src/models/index.js');
  const { computeScenario } = await import('../../../src/tax/scenarios/computeScenario.js');
  const { resolveScenario } = await import('../../../src/tax/scenarios/resolveScenario.js');

  // ----- Step 1+2: create the 2024 baseline anchor scenario via POST -----
  // The POST handler auto-creates the baseline if missing and returns the
  // freshly-minted fork. We want the BASELINE itself (not the fork) as the
  // anchor for /project-next-year, so list and pick it out.
  const initialPost = await authed.post('/api/tax/personal-scenarios').send({
    entityId,
    year: 2024,
    name: 'E2E Anchor Fork',
    overrides: {},
  });
  assert.equal(
    initialPost.status,
    201,
    `expected 201 from initial POST, got ${initialPost.status}: ${JSON.stringify(initialPost.body)}`,
  );
  const list2024 = await authed.get(
    `/api/tax/personal-scenarios?entityId=${entityId}&year=2024`,
  );
  assert.equal(list2024.status, 200);
  const baseline2024 = list2024.body.scenarios.find(
    (s: { kind: string }) => s.kind === 'baseline',
  );
  assert.ok(baseline2024, 'baseline should be auto-created by initial POST');
  assert.equal(baseline2024.year, 2024);

  // ----- Step 3: POST /project-next-year → creates 2025 projection_root -----
  const proj2025Res = await authed
    .post(`/api/tax/personal-scenarios/${baseline2024.id}/project-next-year`)
    .send({});
  assert.equal(
    proj2025Res.status,
    201,
    `expected 201 from project-next-year (2025), got ${proj2025Res.status}: ${JSON.stringify(proj2025Res.body)}`,
  );
  assert.equal(proj2025Res.body.scenario.kind, 'projection_root');
  assert.equal(proj2025Res.body.scenario.year, 2025);
  assert.equal(proj2025Res.body.scenario.parentId, baseline2024.id);
  const proj2025Id = proj2025Res.body.scenario.id;

  // ----- Step 4: /chain returns both scenarios in year order -----
  const chain2 = await authed.get(
    `/api/tax/personal-scenarios/${baseline2024.id}/chain`,
  );
  assert.equal(chain2.status, 200);
  assert.equal(chain2.body.chain.length, 2);
  const years2 = chain2.body.chain.map((e: { scenario: { year: number } }) => e.scenario.year);
  assert.deepEqual(years2, [2024, 2025]);
  assert.equal(chain2.body.chain[0].scenario.id, baseline2024.id);
  assert.equal(chain2.body.chain[1].scenario.id, proj2025Id);

  // ----- Step 5: create 2026 projection_root directly -----
  // /project-next-year refuses to chain a projection_root (Task 4 design:
  // returns 400 'already_projection_root'). For year+2, fabricate the
  // Scenario row and wire next_year_id directly — Task 5 implementer report
  // documented this same approach for the chain walker test.
  const projNextOnProjRes = await authed
    .post(`/api/tax/personal-scenarios/${proj2025Id}/project-next-year`)
    .send({});
  assert.equal(
    projNextOnProjRes.status,
    400,
    `expected 400 chaining projection_root, got ${projNextOnProjRes.status}: ${JSON.stringify(projNextOnProjRes.body)}`,
  );
  assert.equal(projNextOnProjRes.body.error, 'already_projection_root');

  const proj2026 = await models.Scenario.create({
    parentId: proj2025Id,
    householdPlanId: null,
    entityId,
    year: 2026,
    name: 'Projection 2026',
    kind: 'projection_root',
    overrides: {},
    assumptions: {},
    nextYearId: null,
    notes: null,
  });
  await models.Scenario.update(
    { nextYearId: proj2026.id },
    { where: { id: proj2025Id } },
  );

  // ----- Step 6: /chain returns all 3 in year order -----
  const chain3 = await authed.get(
    `/api/tax/personal-scenarios/${baseline2024.id}/chain`,
  );
  assert.equal(chain3.status, 200);
  assert.equal(chain3.body.chain.length, 3);
  const years3 = chain3.body.chain.map((e: { scenario: { year: number } }) => e.scenario.year);
  assert.deepEqual(years3, [2024, 2025, 2026]);
  assert.equal(chain3.body.chain[0].scenario.id, baseline2024.id);
  assert.equal(chain3.body.chain[1].scenario.id, proj2025Id);
  assert.equal(chain3.body.chain[2].scenario.id, proj2026.id);

  // Walking back from the leaf yields the same chain.
  const chain3FromLeaf = await authed.get(
    `/api/tax/personal-scenarios/${proj2026.id}/chain`,
  );
  assert.equal(chain3FromLeaf.status, 200);
  const yearsFromLeaf = chain3FromLeaf.body.chain.map(
    (e: { scenario: { year: number } }) => e.scenario.year,
  );
  assert.deepEqual(yearsFromLeaf, [2024, 2025, 2026]);

  // ----- Step 7: compute 2026 succeeds + ageAtYearEnd is +2 vs baseline -----
  const computed2026 = await computeScenario(proj2026.id);
  assert.ok(computed2026, 'computeScenario(2026) should return a result');
  assert.equal(computed2026.scenarioId, proj2026.id);
  assert.ok(computed2026.totals, '2026 computation should produce totals');
  // The /:id route's computed payload uses the same shape — totalPayable lives
  // under totals (matches the smoke test in routes-personal-scenarios.test.ts).
  assert.ok('totalPayable' in computed2026.totals);

  // Resolve facts to inspect ageAtYearEnd. Baseline (2024) uses User.dob; each
  // projection adds +1 via projectPersonalFactsFromPrevYear, so 2026 should be
  // baseline-age + 2.
  const facts2024 = await resolveScenario(baseline2024.id);
  const facts2026 = await resolveScenario(proj2026.id);
  assert.equal(
    facts2026.year,
    2026,
    'resolved 2026 facts should report year 2026',
  );
  assert.equal(
    facts2026.ageAtYearEnd,
    facts2024.ageAtYearEnd + 2,
    `ageAtYearEnd should be baseline + 2 (got baseline=${facts2024.ageAtYearEnd}, year+2=${facts2026.ageAtYearEnd})`,
  );
  // Sanity-check the underlying age math — DOB 1990 → 34 at end of 2024 → 36 at end of 2026.
  assert.equal(facts2024.ageAtYearEnd, 2024 - 1990);
  assert.equal(facts2026.ageAtYearEnd, 2026 - 1990);

  // ----- Step 8: fork the 2025 projection_root with an override -----
  // Task 3 resolver dispatch handles a fork whose ancestry root is a
  // projection_root: project-from-prev-year supplies base facts, then
  // applyOverrides layers the override on top.
  const fork2025Res = await authed
    .post(`/api/tax/personal-scenarios/${proj2025Id}/fork`)
    .send({ name: '2025 high salary' });
  assert.equal(
    fork2025Res.status,
    201,
    `expected 201 from fork, got ${fork2025Res.status}: ${JSON.stringify(fork2025Res.body)}`,
  );
  const fork2025Id = fork2025Res.body.scenario.id;
  // Set an override via PATCH (POST /:id/fork starts with an empty override map).
  const patch = await authed
    .patch(`/api/tax/personal-scenarios/${fork2025Id}`)
    .send({ overrides: { 'income.employment': 150000 } });
  assert.equal(
    patch.status,
    200,
    `expected 200 from PATCH, got ${patch.status}: ${JSON.stringify(patch.body)}`,
  );

  // Resolve the fork: projection_root base facts (inflated 80k employment)
  // get replaced by the override (150k).
  const fork2025Facts = await resolveScenario(fork2025Id);
  assert.equal(fork2025Facts.year, 2025);
  assert.equal(
    fork2025Facts.employmentIncome.length,
    1,
    'override replaces income line with a single synthetic entry',
  );
  assert.equal(
    fork2025Facts.employmentIncome[0].cadAmount.toFixed(2),
    '150000.00',
  );
  // Compute should succeed too.
  const fork2025Computed = await computeScenario(fork2025Id);
  assert.ok(fork2025Computed.totals);
  assert.ok('totalPayable' in fork2025Computed.totals);
});
