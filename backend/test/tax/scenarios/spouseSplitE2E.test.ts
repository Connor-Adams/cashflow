/**
 * E2E spouse-split test (P10 Task 9 — final P10 task).
 *
 * Drives the whole pension-split pipeline through the HTTP surface to prove
 * the pieces from Tasks 1-8 compose end-to-end:
 *
 *   1. Seed household + two personal entities A + B.
 *   2. Link them as spouses via POST /api/tax/entities/:id/spouse (Task 2).
 *   3. Create scenarios on A (with income.employment=120k acting as pension
 *      income, plus pensionSplit.transferAmount=30k — both override keys from
 *      Task 3) and on B (plain baseline). Link both to a HouseholdPlan.
 *   4. GET /api/tax/household-plans/:id/compute drives computeHouseholdPlan
 *      which invokes spouseRouter (Task 4) wired in by Task 5.
 *   5. Assert: spouseRouter records the shifts cleanly, no missing-spouse
 *      warnings, A's L10100 = 90k effective, B's L10100 = 30k, and joint tax
 *      < hypothetical solo-A tax (the split-benefit value prop).
 *
 * The solo-A reference is computed via a separate non-spouse-linked clone
 * entity inside the same household, then POST'd through
 * /api/tax/personal-scenarios/:id/compute so the comparison rides the same
 * engine + rate table as the plan-routed path.
 *
 * The task spec calls the route "POST /compute" but the actual handler in
 * tax-household-plans.ts mounts it as GET (matches the existing
 * routes-household-plans.test.ts pattern); we use GET here.
 *
 * Compute returns Decimal values as plain strings via Decimal.toJSON (e.g.
 * '30000' not '30000.00'). The asserts use D(...).toFixed(2) to normalise
 * to the dollars-and-cents form the spec calls out.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import crypto from 'crypto';
import { D } from '../../../src/tax/util/decimal';

let app: import('express').Express;
let authed: ReturnType<typeof request.agent>;
let householdId: number;
let aEntityId: number;
let bEntityId: number;
let soloCloneEntityId: number;

function assertStatus(res: request.Response, expected: number): void {
  assert.equal(
    res.status,
    expected,
    `expected ${expected}, got ${res.status}: ${JSON.stringify(res.body)}`,
  );
}

before(async () => {
  process.env.NODE_ENV = 'test';
  const { sequelize } = await import('../../../src/db.js');
  // Models BEFORE sync so every table is registered when sync({force:true}) runs.
  const models = await import('../../../src/models/index.js');
  await sequelize.sync({ force: true });

  const mod = await import('../../../src/app.js');
  app = mod.default;

  const { hashPassword, hashToken } = await import('../../../src/auth/password.js');
  const password = await hashPassword('password123');
  const user = await models.User.create({
    email: `spouse-split-e2e-${Date.now()}@example.com`,
    displayName: 'Spouse Split E2E',
    globalRole: 'user',
    passwordHash: password.hash,
    passwordSalt: password.salt,
    passwordParams: password.params,
  });
  const household = await models.Household.create({ name: 'SpouseSplitE2E HH' });
  householdId = household.id;
  await models.HouseholdMember.create({
    householdId: household.id,
    userId: user.id,
    role: 'owner',
  });

  const a = await models.Entity.create({
    householdId: household.id,
    kind: 'personal',
    legalName: 'A',
    jurisdiction: 'CA-ON',
    fiscalYearEnd: null,
  });
  aEntityId = a.id;
  const b = await models.Entity.create({
    householdId: household.id,
    kind: 'personal',
    legalName: 'B',
    jurisdiction: 'CA-ON',
    fiscalYearEnd: null,
  });
  bEntityId = b.id;

  // Reference entity for the solo-$120k comparison. Deliberately NOT spouse-
  // linked so its scenario takes the cached (non-integrated) path and gives a
  // clean hypothetical for "A alone with full $120k".
  const soloClone = await models.Entity.create({
    householdId: household.id,
    kind: 'personal',
    legalName: 'A-soloClone',
    jurisdiction: 'CA-ON',
    fiscalYearEnd: null,
  });
  soloCloneEntityId = soloClone.id;

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

test('E2E: spouse link + pension split via HouseholdPlan compute lowers joint tax', async () => {
  // 1. Link A <-> B as spouses through the public API (exercises Task 2).
  const linkRes = await authed
    .post(`/api/tax/entities/${aEntityId}/spouse`)
    .send({ spouseEntityId: bEntityId });
  assertStatus(linkRes, 200);
  assert.equal(linkRes.body.entity.spouseEntityId, bEntityId);

  // 2. Create the HouseholdPlan.
  const planRes = await authed
    .post('/api/tax/household-plans')
    .send({ name: 'Pension split 2025', notes: null });
  assertStatus(planRes, 201);
  const planId = planRes.body.plan.id;

  // 3a. A's personal scenario: 120k employment (proxy for pension income;
  //     engine doesn't distinguish in v1) + 30k split to B.
  const aScenRes = await authed.post('/api/tax/personal-scenarios').send({
    entityId: aEntityId,
    year: 2025,
    name: 'A pension split',
    overrides: {
      'income.employment': 120000,
      'pensionSplit.transferAmount': 30000,
    },
  });
  assertStatus(aScenRes, 201);
  const aScenarioId = aScenRes.body.scenario.id;

  // 3b. B's personal scenario: plain baseline-style fork (no overrides) so B
  //     starts at $0 employment income and only the routed split lands.
  const bScenRes = await authed.post('/api/tax/personal-scenarios').send({
    entityId: bEntityId,
    year: 2025,
    name: 'B recipient',
    overrides: {},
  });
  assertStatus(bScenRes, 201);
  const bScenarioId = bScenRes.body.scenario.id;

  // 4. Link both scenarios into the plan.
  const linkScenRes = await authed
    .patch(`/api/tax/household-plans/${planId}`)
    .send({ addScenarioIds: [aScenarioId, bScenarioId] });
  assertStatus(linkScenRes, 200);

  // 5. Compute the plan (handler is GET, not POST — see file header).
  const computeRes = await authed.get(`/api/tax/household-plans/${planId}/compute`);
  assertStatus(computeRes, 200);
  const out = computeRes.body;

  // --- Spouse router output ----------------------------------------------
  // No missing-spouse warnings (Task 4's two warning branches don't fire when
  // both spouses are linked AND both have scenarios in the plan).
  assert.equal(
    out.spouse.warnings.length,
    0,
    `expected zero spouse warnings, got: ${JSON.stringify(out.spouse.warnings)}`,
  );

  // Per-entity shift amounts. Decimal serialises as plain string ('30000');
  // normalise via D(...).toFixed(2) to the '30000.00' form the spec calls out.
  const aShift = out.spouse.byEntityId[aEntityId];
  const bShift = out.spouse.byEntityId[bEntityId];
  assert.ok(aShift, `expected spouse shift for A entity ${aEntityId}`);
  assert.ok(bShift, `expected spouse shift for B entity ${bEntityId}`);
  assert.equal(D(aShift.pensionSplitTransferOut).toFixed(2), '30000.00');
  assert.equal(D(aShift.pensionSplitTransferIn).toFixed(2), '0.00');
  assert.equal(D(bShift.pensionSplitTransferOut).toFixed(2), '0.00');
  assert.equal(D(bShift.pensionSplitTransferIn).toFixed(2), '30000.00');

  // --- Personal compute results -----------------------------------------
  const aResult = out.personal.find(
    (p: { scenario: { entityId: number } }) => p.scenario.entityId === aEntityId,
  );
  const bResult = out.personal.find(
    (p: { scenario: { entityId: number } }) => p.scenario.entityId === bEntityId,
  );
  assert.ok(aResult, 'expected A computed result in plan response');
  assert.ok(bResult, 'expected B computed result in plan response');

  // Both spouses' scenarios go through the integrated (non-cached) path because
  // spouse shifts apply — sentinel hash confirms it.
  assert.equal(aResult.computed.factsHash, 'household-integrated');
  assert.equal(bResult.computed.factsHash, 'household-integrated');

  // A's totalIncome: 120k − 30k split-out = 90k effective.
  // B's totalIncome: 0 baseline + 30k split-in = 30k.
  // (totalIncome lives in totals; Decimal serialises as plain string.)
  assert.equal(
    D(aResult.computed.totals.totalIncome).toFixed(2),
    '90000.00',
    `A totalIncome should reflect 120k − 30k split, got ${aResult.computed.totals.totalIncome}`,
  );
  assert.equal(
    D(bResult.computed.totals.totalIncome).toFixed(2),
    '30000.00',
    `B totalIncome should reflect +30k routed split, got ${bResult.computed.totals.totalIncome}`,
  );

  // --- Split benefit: joint tax < hypothetical solo-A tax ---------------
  // Spin up a sibling personal entity (NOT spouse-linked) and run it solo with
  // the full $120k employment income — that's the "no-split" reference.
  const soloScenRes = await authed.post('/api/tax/personal-scenarios').send({
    entityId: soloCloneEntityId,
    year: 2025,
    name: 'Solo A reference',
    overrides: { 'income.employment': 120000 },
  });
  assertStatus(soloScenRes, 201);
  const soloScenarioId = soloScenRes.body.scenario.id;
  const soloComputeRes = await authed
    .post(`/api/tax/personal-scenarios/${soloScenarioId}/compute`)
    .send({});
  assertStatus(soloComputeRes, 200);

  const soloPayable = D(soloComputeRes.body.computed.totals.totalPayable);
  const splitJointPayable = D(aResult.computed.totals.totalPayable).plus(
    D(bResult.computed.totals.totalPayable),
  );

  assert.ok(
    splitJointPayable.lessThan(soloPayable),
    `expected joint split tax (${splitJointPayable.toFixed(2)}) < solo-A tax ` +
      `(${soloPayable.toFixed(2)}) — pension splitting should reduce joint household tax`,
  );
});
