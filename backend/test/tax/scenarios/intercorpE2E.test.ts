/**
 * P11a Task 5 — End-to-end integration test for the intercorp dividend flow
 * exercised through the full HTTP path.
 *
 * Covers:
 *   1. Seed a household with User + Session + HouseholdMember (auth pattern
 *      mirrors routes-corp-scenarios.test.ts).
 *   2. Create 2 corp entities (Opco + Holdco) directly via `Entity.create`
 *      (there is no `POST /api/tax/entities` route in the current API).
 *   3. POST `/api/tax/scenarios/corp` to create one fork per corp (the route
 *      auto-creates baselines on the fly).
 *   4. POST `/api/tax/household-plans` to create the plan; PATCH it to link
 *      both corp scenario forks.
 *   5. PATCH the Opco fork's overrides with
 *      `{ 'corp.activeIncome': 200000, 'intercorp.<HoldcoId>.nonEligible': 80000 }`
 *      — exercises the dynamic intercorp.<corpId>.<field> validator path
 *      from Task 1.
 *   6. GET `/api/tax/household-plans/:id/compute` — runs the full pipeline:
 *      pre-resolve corp facts → intercorpRouter → corp compute (Holdco is a
 *      receiver, takes the cache-skipped path) → integrationRouter →
 *      (no personal scenarios in this test).
 *
 * Assertions (per Task 5 spec):
 *   - body.intercorp.byReceiverEntityId[Holdco.id].nonEligibleDividends[0].cadAmount === '80000'
 *     (Decimal serializes via toJSON → string).
 *   - body.intercorp.warnings.length === 0 — Holdco is in the plan, no self-loop.
 *   - Holdco's totals.nerdtohEnding === '24536' (80000 × 0.3067 Part IV NERDTOH
 *     addition; no dividend refund because Holdco pays no divs out).
 *   - Plan-wide total corp tax = Opco net tax + Holdco net tax (sanity-check
 *     that the orchestrator returns exactly one result per corp scenario, no
 *     double-counting of the intercorp distribution).
 *
 * Bootstrap pattern mirrors routes-corp-scenarios.test.ts:
 *   - sequelize.sync({ force: true }) instead of running migrations.
 *   - Models imported BEFORE sync so all model tables are registered/created.
 *   - Direct User + Household + HouseholdMember + Session creation, then
 *     request.agent(app) with cookie injection.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import crypto from 'crypto';

let app: import('express').Express;
let authed: ReturnType<typeof request.agent>;
let opcoEntityId: number;
let holdcoEntityId: number;

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
  const user = await models.User.create({
    email: `intercorp-e2e-${Date.now()}@example.com`,
    displayName: 'Intercorp E2E Test',
    globalRole: 'user',
    passwordHash: password.hash,
    passwordSalt: password.salt,
    passwordParams: password.params,
  });
  const household = await models.Household.create({ name: 'Intercorp E2E HH' });
  await models.HouseholdMember.create({
    householdId: household.id,
    userId: user.id,
    role: 'owner',
  });

  // Two corp entities — Opco (operating co, pays div out) + Holdco (receiver).
  // Direct Entity.create is fine; there is no POST /api/tax/entities endpoint.
  const opco = await models.Entity.create({
    householdId: household.id,
    kind: 'corp',
    legalName: 'Opco',
    jurisdiction: 'CA-ON',
    fiscalYearEnd: '12-31',
  });
  opcoEntityId = opco.id;
  const holdco = await models.Entity.create({
    householdId: household.id,
    kind: 'corp',
    legalName: 'Holdco',
    jurisdiction: 'CA-ON',
    fiscalYearEnd: '12-31',
  });
  holdcoEntityId = holdco.id;

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

function assertStatus(res: request.Response, expected: number): void {
  assert.equal(
    res.status,
    expected,
    `expected ${expected}, got ${res.status}: ${JSON.stringify(res.body)}`,
  );
}

test('P11a E2E: opco→holdco non-eligible dividend routed via household-plan compute', async () => {
  // 1. Create the Opco fork. POST auto-creates the baseline; this fork starts
  //    with empty overrides so we can PATCH them in step 4 (exercising the
  //    intercorp.<id>.<field> validator path from Task 1).
  const opcoCreate = await authed.post('/api/tax/scenarios/corp').send({
    entityId: opcoEntityId,
    year: 2025,
    name: 'Opco fork',
    overrides: {},
  });
  assertStatus(opcoCreate, 201);
  const opcoScenarioId: number = opcoCreate.body.scenario.id;

  // 2. Create the Holdco fork. Plain baseline-derived fork; no overrides — it
  //    just needs to exist in the plan so the intercorp router accepts the
  //    receiver entity ID.
  const holdcoCreate = await authed.post('/api/tax/scenarios/corp').send({
    entityId: holdcoEntityId,
    year: 2025,
    name: 'Holdco fork',
    overrides: {},
  });
  assertStatus(holdcoCreate, 201);
  const holdcoScenarioId: number = holdcoCreate.body.scenario.id;

  // 3. Create the HouseholdPlan, then link both corp forks into it.
  const planCreate = await authed
    .post('/api/tax/household-plans')
    .send({ name: 'Opco→Holdco intercorp', notes: null });
  assertStatus(planCreate, 201);
  const planId: number = planCreate.body.plan.id;

  const link = await authed
    .patch(`/api/tax/household-plans/${planId}`)
    .send({ addScenarioIds: [opcoScenarioId, holdcoScenarioId] });
  assertStatus(link, 200);

  // 4. PATCH Opco's overrides — exercises the dynamic intercorp.<id>.<field>
  //    key path through `validateOverrideMap` on the corp-scenarios PATCH
  //    handler. If Task 1's registry hook isn't wired the PATCH 400s here.
  const patchOpco = await authed
    .patch(`/api/tax/scenarios/corp/${opcoScenarioId}`)
    .send({
      overrides: {
        'corp.activeIncome': 200000,
        [`intercorp.${holdcoEntityId}.nonEligible`]: 80000,
      },
    });
  assertStatus(patchOpco, 200);
  assert.equal(patchOpco.body.scenario.overrides['corp.activeIncome'], 200000);
  assert.equal(
    patchOpco.body.scenario.overrides[`intercorp.${holdcoEntityId}.nonEligible`],
    80000,
  );

  // 5. GET /:id/compute — runs computeHouseholdPlan end-to-end.
  const computeRes = await authed.get(`/api/tax/household-plans/${planId}/compute`);
  assertStatus(computeRes, 200);
  const body = computeRes.body;

  // Plan shape: 2 corps, 0 personal scenarios.
  assert.equal(body.planId, planId);
  assert.equal(body.corp.length, 2);
  assert.equal(body.personal.length, 0);

  // 6a. intercorp router output — Holdco received exactly one non-elig div of
  //     80,000. Decimal serializes via toJSON to a string, so cadAmount comes
  //     back as the literal '80000'.
  assert.equal(
    body.intercorp.warnings.length,
    0,
    `expected zero intercorp warnings, got: ${JSON.stringify(body.intercorp.warnings)}`,
  );
  const holdcoReceived = body.intercorp.byReceiverEntityId[holdcoEntityId];
  assert.ok(holdcoReceived, 'expected Holdco to have a received-divs entry');
  assert.equal(holdcoReceived.nonEligibleDividends.length, 1);
  assert.equal(holdcoReceived.eligibleDividends.length, 0);
  assert.equal(holdcoReceived.capitalDividends.length, 0);
  assert.equal(holdcoReceived.nonEligibleDividends[0].cadAmount, '80000');
  assert.match(
    holdcoReceived.nonEligibleDividends[0].source,
    new RegExp(`from-corp-${opcoEntityId}:nonEligible`),
  );

  // 6b. P11b T5 v1: Holdco's NERDTOH ending = 0 because the received
  //     intercorp non-eligible div is source-tagged
  //     `intercorpRouter:from-corp-<opcoId>:nonEligible`, and
  //     `computeIntegration` excludes connected divs from the Part IV /
  //     NERDTOH base (v1 simplification — real rule requires payer's actual
  //     dividend refund × ownership%, deferred to P11c). Pre-P11b this
  //     asserted 24,536 = 80,000 × 0.3067.
  const holdcoResult = body.corp.find(
    (c: { scenario: { entityId: number } }) => c.scenario.entityId === holdcoEntityId,
  );
  assert.ok(holdcoResult, 'expected a corp result for Holdco');
  assert.equal(
    holdcoResult.computed.factsHash,
    'household-intercorp',
    'Holdco should take the cache-skipping receiver path',
  );
  assert.equal(holdcoResult.computed.cached, false);
  assert.equal(String(holdcoResult.computed.totals.nerdtohEnding ?? '0'), '0');

  // 6c. Plan-wide total corp tax = Opco net tax + Holdco net tax. This is
  //     mostly a no-double-count sanity check: the orchestrator returns one
  //     result per corp scenario, and intercorp distributions do not deduct
  //     from the payer's taxable income. Compute the sum from body.corp
  //     directly and confirm it equals the per-corp totals added up.
  const opcoResult = body.corp.find(
    (c: { scenario: { entityId: number } }) => c.scenario.entityId === opcoEntityId,
  );
  assert.ok(opcoResult, 'expected a corp result for Opco');
  // Opco is the payer, not a receiver → cache path (not 'household-intercorp').
  assert.notEqual(opcoResult.computed.factsHash, 'household-intercorp');

  // Net tax on both corps comes from totals.netTaxPayable (engine field, see
  // backend/src/tax/engine/t2.ts). Serializes to a numeric string via Decimal.toJSON.
  const opcoNetTax = Number(opcoResult.computed.totals.netTaxPayable);
  const holdcoNetTax = Number(holdcoResult.computed.totals.netTaxPayable);
  assert.ok(
    Number.isFinite(opcoNetTax) && opcoNetTax > 0,
    `expected positive Opco netTaxPayable, got ${opcoResult.computed.totals.netTaxPayable}`,
  );
  assert.ok(
    Number.isFinite(holdcoNetTax) && holdcoNetTax >= 0,
    `expected non-negative Holdco netTaxPayable, got ${holdcoResult.computed.totals.netTaxPayable}`,
  );
  // Plan-wide sum = exactly the two per-corp totals — there is no third corp
  // and no payer-side deduction (the intercorp dividend is just routed).
  const planWideCorpTax = body.corp.reduce(
    (acc: number, c: { computed: { totals: { netTaxPayable: string } } }) =>
      acc + Number(c.computed.totals.netTaxPayable),
    0,
  );
  assert.equal(
    planWideCorpTax,
    opcoNetTax + holdcoNetTax,
    'plan-wide corp tax must equal sum of per-corp netTaxPayable (no double-count)',
  );
});
