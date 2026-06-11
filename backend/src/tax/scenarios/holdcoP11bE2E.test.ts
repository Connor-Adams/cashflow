/**
 * P11b Task 8 — End-to-end integration test for the complete holdco mechanics:
 * associated-group SBD grind (T2 rollup + T3 engine accept) + ownership-%-scaled
 * intercorp eligible dividend (T4 + T6 router) + connected-vs-portfolio Part IV
 * distinction (T5 v1 simplification) + GRIP designation flow into receiver
 * (T6 router + buildT2 stamp).
 *
 * Covers the wiring step added in T8: `computeHouseholdPlan` now invokes
 * `computeGroupAaii` over the resolved per-corp facts AND forces the cache-
 * bypass path (`computeIntegratedCorp`) for any corp whose entity has a non-
 * null `associatedGroupId`. Before T8, a corp could be in a group but the
 * group-AAII rollup never reached the engine; the cached `computeCorpScenario`
 * path took precedence whenever the corp wasn't a dividend receiver, so the
 * SBD grind silently used per-corp AAII (incorrect for grouped corps).
 *
 * Test scenario (mirrors plan T8 fixture):
 *   1. Seed household + 2 corps (Opco, Holdco) both tagged
 *      `associatedGroupId = "ABCorp"`.
 *   2. Create 2 corp forks (auto-baseline via POST /api/tax/scenarios/corp)
 *      linked to a single HouseholdPlan.
 *   3. Opco overrides: activeIncome=$400k, passiveInvestmentIncome=$60k,
 *      intercorp.<Holdco>.eligible=$50k, intercorp.<Holdco>.ownershipPercent=100.
 *   4. Holdco: baseline (no overrides).
 *   5. GET /api/tax/household-plans/:id/compute — runs the full pipeline.
 *
 * Assertions (per plan T8 spec):
 *   - Group AAII = $60k (Opco interest only; Holdco contributes nothing).
 *   - Group AAII > $50k threshold → SBD grind kicks in on Opco:
 *     limit = $500k - ($60k - $50k) × $5 = $450k.
 *   - Opco's ABI ($400k) ≤ grind-reduced limit ($450k) → full ABI gets SBD rate
 *     (sbdEligibleIncome = $400k, generalRateIncome = $0).
 *   - Holdco's `nerdtohEnding` ≈ $0 (no portfolio non-eligible divs received;
 *     the eligible div from Opco is CONNECTED per T5 v1 → excluded from
 *     Part IV / RDTOH base).
 *   - Holdco's `gripEnding` includes the routed gripBoost of $50k × 100% =
 *     $50k (T6 designation flow).
 *   - Holdco's Part IV ≈ $0 on the connected eligible div (T5 v1 simplification).
 *   - Plan-wide corp tax = Σ per-corp `netTaxPayable` (no double-count).
 *   - Both corps land on the cache-bypass path (`factsHash` =
 *     `'household-intercorp'`) — Opco because it's in a group; Holdco because
 *     it's both a receiver AND in a group.
 *
 * Auth bootstrap mirrors intercorpE2E.test.ts (P11a T5): sequelize.sync({
 * force: true }) for a clean DB, direct User/Household/HouseholdMember/Session
 * creation, then request.agent(app) with the session cookie injected.
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
  const { sequelize } = await import('../../db.js');
  // Import models BEFORE sync so all model tables are registered/created.
  const models = await import('../../models/index.js');
  await sequelize.sync({ force: true });

  const mod = await import('../../app.js');
  app = mod.default;

  const { hashPassword, hashToken } = await import('../../auth/password.js');

  const password = await hashPassword('password123');
  const user = await models.User.create({
    email: `holdco-p11b-e2e-${Date.now()}@example.com`,
    displayName: 'Holdco P11b E2E Test',
    globalRole: 'user',
    passwordHash: password.hash,
    passwordSalt: password.salt,
    passwordParams: password.params,
  });
  const household = await models.Household.create({ name: 'Holdco P11b E2E HH' });
  await models.HouseholdMember.create({
    householdId: household.id,
    userId: user.id,
    role: 'owner',
  });

  // Two corp entities tagged into the SAME associated group "ABCorp". The
  // group string is opaque — engine treats it as just a tag for the SBD/AAII
  // rollup (no s.256 auto-detection; user manually groups corps).
  const opco = await models.Entity.create({
    householdId: household.id,
    kind: 'corp',
    legalName: 'Opco',
    jurisdiction: 'CA-ON',
    fiscalYearEnd: '12-31',
    associatedGroupId: 'ABCorp',
  });
  opcoEntityId = opco.id;
  const holdco = await models.Entity.create({
    householdId: household.id,
    kind: 'corp',
    legalName: 'Holdco',
    jurisdiction: 'CA-ON',
    fiscalYearEnd: '12-31',
    associatedGroupId: 'ABCorp',
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
  const { sequelize } = await import('../../db.js');
  await sequelize.close();
});

function assertStatus(res: request.Response, expected: number): void {
  assert.equal(
    res.status,
    expected,
    `expected ${expected}, got ${res.status}: ${JSON.stringify(res.body)}`,
  );
}

test('P11b E2E: associated group + connected eligible div + GRIP flow via household-plan compute', async () => {
  // 1. Create Opco fork. POST auto-creates the baseline; this fork starts
  //    empty so we can PATCH the overrides in step 4 (exercising the
  //    intercorp.<id>.<field> + ownershipPercent validator paths from T4).
  const opcoCreate = await authed.post('/api/tax/scenarios/corp').send({
    entityId: opcoEntityId,
    year: 2025,
    name: 'Opco fork',
    overrides: {},
  });
  assertStatus(opcoCreate, 201);
  const opcoScenarioId: number = opcoCreate.body.scenario.id;

  // 2. Create Holdco fork. Plain — no overrides; it just needs to exist in
  //    the plan so the intercorp router accepts it as a receiver AND so it
  //    appears in `corpFactsByEntityId` for the group-AAII rollup.
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
    .send({ name: 'Holdco P11b E2E', notes: null });
  assertStatus(planCreate, 201);
  const planId: number = planCreate.body.plan.id;

  const link = await authed
    .patch(`/api/tax/household-plans/${planId}`)
    .send({ addScenarioIds: [opcoScenarioId, holdcoScenarioId] });
  assertStatus(link, 200);

  // 4. PATCH Opco's overrides — activeIncome + passiveInvestmentIncome +
  //    intercorp eligible div to Holdco (ownership 100). Exercises both the
  //    static corp.* keys and the dynamic intercorp.<id>.<field> validator
  //    paths (T4 added the ownershipPercent suffix).
  const patchOpco = await authed
    .patch(`/api/tax/scenarios/corp/${opcoScenarioId}`)
    .send({
      overrides: {
        'corp.activeIncome': 400000,
        'corp.passiveInvestmentIncome': 60000,
        [`intercorp.${holdcoEntityId}.eligible`]: 50000,
        [`intercorp.${holdcoEntityId}.ownershipPercent`]: 100,
      },
    });
  assertStatus(patchOpco, 200);
  assert.equal(patchOpco.body.scenario.overrides['corp.activeIncome'], 400000);
  assert.equal(patchOpco.body.scenario.overrides['corp.passiveInvestmentIncome'], 60000);
  assert.equal(
    patchOpco.body.scenario.overrides[`intercorp.${holdcoEntityId}.eligible`],
    50000,
  );
  assert.equal(
    patchOpco.body.scenario.overrides[`intercorp.${holdcoEntityId}.ownershipPercent`],
    100,
  );

  // 5. GET /:id/compute — runs computeHouseholdPlan end-to-end including the
  //    T8 wiring step (computeGroupAaii → inject `facts.groupAaii` → force
  //    cache-bypass for both grouped corps).
  const computeRes = await authed.get(`/api/tax/household-plans/${planId}/compute`);
  assertStatus(computeRes, 200);
  const body = computeRes.body;

  // Plan structure sanity: 2 corps, 0 personal scenarios.
  assert.equal(body.planId, planId);
  assert.equal(body.corp.length, 2);
  assert.equal(body.personal.length, 0);

  // intercorp router: zero warnings (Holdco is in the plan, no self-loop)
  // and a single received-divs entry for Holdco.
  assert.equal(
    body.intercorp.warnings.length,
    0,
    `expected zero intercorp warnings, got: ${JSON.stringify(body.intercorp.warnings)}`,
  );
  const holdcoReceived = body.intercorp.byReceiverEntityId[holdcoEntityId];
  assert.ok(holdcoReceived, 'expected Holdco to have a received-divs entry');
  assert.equal(holdcoReceived.eligibleDividends.length, 1);
  assert.equal(holdcoReceived.nonEligibleDividends.length, 0);
  assert.equal(holdcoReceived.capitalDividends.length, 0);
  assert.equal(holdcoReceived.eligibleDividends[0].cadAmount, '50000');
  // Source tag carries the from-corp- prefix → integration.ts treats as
  // CONNECTED → excluded from Part IV / RDTOH base.
  assert.match(
    holdcoReceived.eligibleDividends[0].source,
    new RegExp(`from-corp-${opcoEntityId}:eligible`),
  );
  // gripBoost = 50000 × 100/100 = 50000 (default ownership).
  assert.equal(holdcoReceived.gripBoost, '50000');

  // Locate each corp's compute result for the targeted assertions.
  const opcoResult = body.corp.find(
    (c: { scenario: { entityId: number } }) => c.scenario.entityId === opcoEntityId,
  );
  const holdcoResult = body.corp.find(
    (c: { scenario: { entityId: number } }) => c.scenario.entityId === holdcoEntityId,
  );
  assert.ok(opcoResult, 'expected a corp result for Opco');
  assert.ok(holdcoResult, 'expected a corp result for Holdco');

  // T8 wiring: BOTH corps land on the cache-bypass path. Opco because it's
  // in the associated group (forces groupAaii injection); Holdco because it
  // both receives intercorp divs AND is in the group.
  assert.equal(
    opcoResult.computed.factsHash,
    'household-intercorp',
    'Opco should use the cache-bypass path because it is in an associated group',
  );
  assert.equal(opcoResult.computed.cached, false);
  assert.equal(
    holdcoResult.computed.factsHash,
    'household-intercorp',
    'Holdco should use the cache-bypass path (receiver + grouped)',
  );
  assert.equal(holdcoResult.computed.cached, false);

  // ------------------------------------------------------------------------
  // Engine-line assertions: cross-check the T8 group-AAII injection is
  // actually feeding the SBD grind on Opco. T2 emits an `L417G` line ONLY
  // when `facts.groupAaii` is present (see t2.ts L26-29). Its absence means
  // the wiring didn't reach the engine.
  // ------------------------------------------------------------------------
  const opcoLines = opcoResult.computed.lines as Array<{ code: string; amount: string }>;
  const groupAaiiLine = opcoLines.find((l) => l.code === 'L417G');
  assert.ok(
    groupAaiiLine,
    'expected L417G (group AAII) line on Opco T2 — proves T8 wiring delivered facts.groupAaii to the engine',
  );
  assert.equal(
    groupAaiiLine.amount,
    '60000',
    'group AAII should sum to $60k (Opco interest only; Holdco contributes nothing)',
  );

  // SBD limit after grind: $500k - ($60k - $50k) × $5 = $450k.
  const sbdLimitLine = opcoLines.find((l) => l.code === 'L425');
  assert.ok(sbdLimitLine, 'expected L425 (SBD limit after AAII grind) on Opco T2');
  assert.equal(
    sbdLimitLine.amount,
    '450000',
    'SBD limit should be $450k after $50k grind from group AAII exceeding threshold by $10k × $5',
  );

  // SBD-eligible income = min(ABI=$400k, limit=$450k) = $400k → full ABI
  // gets SBD rate. General-rate income should be zero.
  const sbdEligibleLine = opcoLines.find((l) => l.code === 'L427');
  assert.ok(sbdEligibleLine, 'expected L427 (SBD-eligible income) on Opco T2');
  assert.equal(
    sbdEligibleLine.amount,
    '400000',
    'Opco ABI ($400k) should fully fit under the grind-reduced limit ($450k)',
  );
  const generalRateLine = opcoLines.find((l) => l.code === 'L430');
  assert.ok(generalRateLine, 'expected L430 (general-rate income) on Opco T2');
  assert.equal(
    generalRateLine.amount,
    '0',
    'Opco should have zero general-rate income (full ABI is SBD-eligible)',
  );

  // Mirror check on Holdco's L417G — confirms the same group AAII is
  // injected into Holdco's facts (proves the rollup is per-group, not
  // per-corp).
  const holdcoLines = holdcoResult.computed.lines as Array<{ code: string; amount: string }>;
  const holdcoGroupAaiiLine = holdcoLines.find((l) => l.code === 'L417G');
  assert.ok(holdcoGroupAaiiLine, 'expected L417G on Holdco T2 too');
  assert.equal(holdcoGroupAaiiLine.amount, '60000');

  // ------------------------------------------------------------------------
  // T5 v1: Holdco's NERDTOH ending = 0. The received eligible div is
  // source-tagged `intercorpRouter:from-corp-<opcoId>:eligible` → CONNECTED →
  // computeIntegration excludes it from the Part IV / RDTOH base entirely.
  // No non-eligible divs received either, so nerdtohAddition = 0.
  // ------------------------------------------------------------------------
  assert.equal(
    String(holdcoResult.computed.totals.nerdtohEnding ?? '0'),
    '0',
    'Holdco NERDTOH ending should be 0 (T5 v1: connected eligible div excluded from Part IV)',
  );

  // T5 v1 corollary: Holdco's dividendRefund is 0 because it pays no
  // dividends out itself. The connected Part IV simplification (Part IV = 0
  // on connected divs) gives the receiver no extra RDTOH balance from the
  // routed transfer.
  assert.equal(
    String(holdcoResult.computed.totals.dividendRefund ?? '0'),
    '0',
    'Holdco dividendRefund should be 0 (no dividends paid out by Holdco)',
  );

  // ------------------------------------------------------------------------
  // T6: Holdco's gripEnding includes the routed gripBoost of $50k. Holdco
  // has no own general-rate income (gripAddition = 0) and no eligible divs
  // paid out → ending = priorGrip 0 + gripAddition 0 + boost 50k - 0 = 50k.
  // ------------------------------------------------------------------------
  const holdcoBoostLine = holdcoLines.find((l) => l.code === 'L500B');
  assert.ok(
    holdcoBoostLine,
    'expected L500B (GRIP boost from intercorp eligible dividends) on Holdco T2',
  );
  assert.equal(
    holdcoBoostLine.amount,
    '50000',
    'GRIP boost should equal eligible div × ownership/100 = 50000 × 100/100',
  );
  assert.equal(
    String(holdcoResult.computed.totals.gripEnding ?? '0'),
    '50000',
    'Holdco gripEnding should be 50k (priorGrip 0 + own gripAddition 0 + boost 50k)',
  );

  // ------------------------------------------------------------------------
  // Plan-wide corp tax = exactly Opco net + Holdco net. The intercorp
  // distribution is routed (not deducted at the payer); group AAII shares
  // the SBD limit but does not double-count income. There should be no
  // third corp and no implicit additions.
  // ------------------------------------------------------------------------
  const opcoNetTax = Number(opcoResult.computed.totals.netTaxPayable);
  const holdcoNetTax = Number(holdcoResult.computed.totals.netTaxPayable);
  assert.ok(
    Number.isFinite(opcoNetTax) && opcoNetTax > 0,
    `expected positive Opco netTaxPayable, got ${opcoResult.computed.totals.netTaxPayable}`,
  );
  // s.112(1): the routed $50k connected eligible dividend is deductible in
  // computing Holdco's taxable income, so Holdco owes NO Part I tax on it
  // (previously this asserted ~50% investment-rate tax — that was the bug).
  assert.ok(
    Number.isFinite(holdcoNetTax) && holdcoNetTax === 0,
    `expected zero Holdco netTaxPayable (s.112 deduction on connected div), got ${holdcoResult.computed.totals.netTaxPayable}`,
  );
  const planWideCorpTax = body.corp.reduce(
    (acc: number, c: { computed: { totals: { netTaxPayable: string } } }) =>
      acc + Number(c.computed.totals.netTaxPayable),
    0,
  );
  assert.equal(
    planWideCorpTax,
    opcoNetTax + holdcoNetTax,
    'plan-wide corp tax must equal sum of per-corp netTaxPayable (no double-count from group rollup)',
  );
});
