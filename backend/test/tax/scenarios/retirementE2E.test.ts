/**
 * P12 Task 4 — E2E retirement income projection test (final P12 task).
 *
 * Proves the three new retirement override keys from T2 (income.pensionIncome,
 * income.cppRetirement, income.oasRetirement) compose end-to-end with the
 * existing engine machinery for age-65+ filers:
 *   - L23500 OAS clawback (existing, age-independent — fires on net income
 *     above the rate-table threshold; $95,977 in the 2026 PROJECTED table)
 *   - L31400 federal pension income credit (existing, capped at $2,000)
 *   - Age amount credit federal+ON (existing, requires ageAtYearEnd ≥ 65)
 *
 * Direct seed-then-computeScenario flow (no HTTP). The compute path reads
 * facts from buildPersonalFacts which looks up DOB via the household-member
 * → User chain — so we wire the entity to a household whose owner has a DOB
 * making them age 72 at year-end 2026 (1954-01-15).
 *
 * Two test cases per spec:
 *   1. No-clawback floor: $50k pension + $16k CPP + $8.5k OAS = $74.5k
 *      < $95,977 → L23500 NOT emitted, but pension credit + age amount fire.
 *   2. Clawback-triggered: $120k pension (rest same) puts net income above
 *      threshold so L23500 fires AND age amount may phase out (ageAmount
 *      reduces 15% above $46,751; at $144.5k net income it phases to $0).
 *
 * The compute returns Decimal values as plain strings (Decimal.toJSON).
 * Normalise via D(...).toFixed(2) for the dollar-and-cents asserts.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { D } from '../../../src/tax/util/decimal';

let entityId: number;

before(async () => {
  process.env.NODE_ENV = 'test';
  const { sequelize } = await import('../../../src/db.js');
  // Models BEFORE sync so every table is registered when sync({force:true}) runs.
  const models = await import('../../../src/models/index.js');
  await sequelize.sync({ force: true });

  const { hashPassword } = await import('../../../src/auth/password.js');
  const password = await hashPassword('password123');

  // DOB 1954-01-15 → age 72 at end of 2026 (well past the rate-table
  // ageAmountAge=65 floor so the age-credit branch in t1.ts runs).
  const user = await models.User.create({
    email: `retirement-e2e-${Date.now()}@example.com`,
    displayName: 'Retirement E2E',
    globalRole: 'user',
    passwordHash: password.hash,
    passwordSalt: password.salt,
    passwordParams: password.params,
    dob: '1954-01-15',
  });
  const household = await models.Household.create({ name: 'RetirementE2E HH' });
  await models.HouseholdMember.create({
    householdId: household.id,
    userId: user.id,
    role: 'owner',
  });
  const entity = await models.Entity.create({
    householdId: household.id,
    kind: 'personal',
    legalName: 'Senior',
    jurisdiction: 'CA-ON',
    fiscalYearEnd: null,
  });
  entityId = entity.id;
});

after(async () => {
  const { sequelize } = await import('../../../src/db.js');
  await sequelize.close();
});

test('age-72 senior — $74.5k retirement income → no OAS clawback, pension credit + age amount applied', async () => {
  const models = await import('../../../src/models/index.js');
  const { computeScenario } = await import('../../../src/tax/scenarios/computeScenario.js');
  const { resolveScenario } = await import('../../../src/tax/scenarios/resolveScenario.js');

  // Baseline (no overrides) so we can attach a fork with retirement overrides.
  const baseline = await models.Scenario.create({
    parentId: null,
    householdPlanId: null,
    entityId,
    year: 2026,
    name: 'Baseline 2026',
    kind: 'baseline',
    overrides: {},
    assumptions: {},
    nextYearId: null,
    notes: null,
  });

  // Fork that types in the three retirement income amounts directly.
  // 50k pension + 16k CPP + 8.5k OAS = $74,500 < $95,977 threshold.
  const scenario = await models.Scenario.create({
    parentId: baseline.id,
    householdPlanId: null,
    entityId,
    year: 2026,
    name: 'No-clawback retirement',
    kind: 'fork',
    overrides: {
      'income.pensionIncome': 50000,
      'income.cppRetirement': 16000,
      'income.oasRetirement': 8500,
    },
    assumptions: {},
    nextYearId: null,
    notes: null,
  });

  // Sanity-check that the DOB → ageAtYearEnd plumbing landed (age 72 in 2026).
  const facts = await resolveScenario(scenario.id);
  assert.equal(facts.ageAtYearEnd, 72, `expected age 72 at end of 2026, got ${facts.ageAtYearEnd}`);
  assert.equal(
    facts.pensionIncome?.toFixed(2),
    '50000.00',
    'income.pensionIncome override should stamp facts.pensionIncome for credit calc',
  );

  const computed = await computeScenario(scenario.id);

  // Total income = sum of the three retirement amounts (no other actuals seeded).
  // Compute returns Decimal values as plain strings (Decimal.toJSON); normalise.
  assert.equal(
    D(computed.totals.totalIncome as string).toFixed(2),
    '74500.00',
    `expected totalIncome 74500.00, got ${computed.totals.totalIncome}`,
  );

  // L23500 OAS clawback: $74.5k < $95,977 (2026 projected threshold) → not emitted.
  const lines = computed.lines as { code: string; amount: string }[];
  const l23500 = lines.find((l) => l.code === 'L23500');
  assert.equal(
    l23500,
    undefined,
    `expected L23500 NOT emitted at $74.5k income (< clawback threshold), got: ${JSON.stringify(l23500)}`,
  );

  // L42000 (net federal tax) inputs include 'Pension income credit' line.
  // pensionIncome=$50k is capped at $2,000, × 0.15 federal low rate = $300 credit.
  const l42000 = lines.find((l) => l.code === 'L42000') as
    | undefined
    | { inputs: { source: string; amount: string }[] };
  assert.ok(l42000, 'L42000 (net federal tax) should be present');
  const pensionCredit = l42000.inputs.find((i) => i.source === 'Pension income credit');
  assert.ok(pensionCredit, 'L42000 inputs should include "Pension income credit"');
  assert.equal(
    D(pensionCredit.amount).toFixed(2),
    '300.00',
    `pension income credit should be min(50000,2000)×0.15=300.00, got ${pensionCredit.amount}`,
  );

  // Age amount applied: ageAtYearEnd=72 ≥ 65, so the age × low-rate row should
  // be > 0. Net income (~$74.5k) is above the federal age-amount threshold
  // ($46,751) so the credit is reduced 15% per dollar over — at $74.5k net
  // income that's (74500-46751)×0.15 = $4162.35 reduction; full = $9,272
  // → applied amount = 9272 - 4162.35 = $5,109.65; × 0.15 low rate = $766.45.
  const ageRow = l42000.inputs.find((i) => i.source === 'Age × low rate');
  assert.ok(ageRow, 'L42000 inputs should include "Age × low rate" for age-65+ filers');
  assert.ok(
    D(ageRow.amount).greaterThan(0),
    `age amount × low rate should be > 0 for age-72 senior, got ${ageRow.amount}`,
  );
});

test('age-72 senior — $144.5k retirement income → OAS clawback fires (L23500 > 0)', async () => {
  const models = await import('../../../src/models/index.js');
  const { computeScenario } = await import('../../../src/tax/scenarios/computeScenario.js');

  // Reuse the baseline (auto-created above wasn't kept around — fetch the same
  // (entityId, year) baseline directly).
  const baseline = await models.Scenario.findOne({
    where: { entityId, year: 2026, kind: 'baseline' },
  });
  assert.ok(baseline, 'baseline 2026 should already exist from prior test');

  // $120k pension + $16k CPP + $8.5k OAS = $144,500 > $95,977 threshold.
  const scenario = await models.Scenario.create({
    parentId: baseline.id,
    householdPlanId: null,
    entityId,
    year: 2026,
    name: 'Clawback retirement',
    kind: 'fork',
    overrides: {
      'income.pensionIncome': 120000,
      'income.cppRetirement': 16000,
      'income.oasRetirement': 8500,
    },
    assumptions: {},
    nextYearId: null,
    notes: null,
  });

  const computed = await computeScenario(scenario.id);

  assert.equal(
    D(computed.totals.totalIncome as string).toFixed(2),
    '144500.00',
    `expected totalIncome 144500.00, got ${computed.totals.totalIncome}`,
  );

  // L23500 clawback IS emitted: 15% × (netIncome − $95,977).
  // netIncome ≈ totalIncome = $144,500 (no RRSP/FHSA deduction).
  // clawback ≈ (144500 − 95977) × 0.15 = $7,278.45.
  const lines = computed.lines as { code: string; amount: string }[];
  const l23500 = lines.find((l) => l.code === 'L23500');
  assert.ok(
    l23500,
    `expected L23500 emitted at $144.5k income (> clawback threshold), missing from lines`,
  );
  assert.ok(
    D(l23500.amount).greaterThan(0),
    `expected L23500 > 0, got ${l23500.amount}`,
  );
  // Sanity: exactly (144500 − 95977) × 0.15 = 7,278.45
  const expectedClawback = D('144500').minus(D('95977')).times(D('0.15'));
  assert.equal(
    D(l23500.amount).toFixed(2),
    expectedClawback.toFixed(2),
    `expected L23500 = ${expectedClawback.toFixed(2)}, got ${l23500.amount}`,
  );

  // Pension credit still fires (cap is fixed at $2,000 regardless of income).
  const l42000 = lines.find((l) => l.code === 'L42000') as
    | undefined
    | { inputs: { source: string; amount: string }[] };
  assert.ok(l42000, 'L42000 should be present');
  const pensionCredit = l42000.inputs.find((i) => i.source === 'Pension income credit');
  assert.ok(pensionCredit, 'pension credit should still apply at any income level');
  assert.equal(D(pensionCredit.amount).toFixed(2), '300.00');
});
