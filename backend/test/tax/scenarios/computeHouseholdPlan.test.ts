// backend/test/tax/scenarios/computeHouseholdPlan.test.ts
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { sequelize } from '../../../src/db';
import {
  Account, Entity, Household, HouseholdPlan, Scenario, Transaction,
} from '../../../src/models';
import { computeHouseholdPlan } from '../../../src/tax/scenarios/computeHouseholdPlan';
import { ensureCorpBaselineScenario } from '../../../src/tax/scenarios/resolveCorpScenario';
import { ensureBaselineScenario } from '../../../src/tax/scenarios/resolveScenario';

beforeEach(async () => {
  await sequelize.sync({ force: true });
});

async function seedHouseholdWithCorpAndPersonal() {
  const household = await Household.create({ name: 'T' });
  const personal = await Entity.create({
    householdId: household.id, kind: 'personal', legalName: 'P',
    jurisdiction: 'CA-ON', fiscalYearEnd: null,
  });
  const corp = await Entity.create({
    householdId: household.id, kind: 'corp', legalName: 'C',
    jurisdiction: 'CA-ON', fiscalYearEnd: '12-31',
  });
  const corpAccount = await Account.create({
    name: 'CorpChk', householdId: household.id, accountType: 'checking',
    entityId: corp.id, taxStatus: 'non_registered', defaultCurrency: 'CAD',
  } as never);
  await Transaction.create({
    accountId: corpAccount.id, householdId: household.id, entityId: corp.id,
    date: '2025-03-15', amount: '300000', currency: 'CAD',
    finalCategory: 'business_revenue', finalBusiness: true,
    merchantRaw: 'C', merchantClean: 'C',
    importBatch: 'b', sourceRowFingerprint: 'fp1', sourceIdentityFingerprint: 'sif1',
  } as never);
  return { household, personal, corp };
}

test('computeHouseholdPlan with no linked scenarios returns empty bundle', async () => {
  const { household } = await seedHouseholdWithCorpAndPersonal();
  const plan = await HouseholdPlan.create({
    householdId: household.id, name: 'Empty', notes: null,
  });
  const out = await computeHouseholdPlan(plan.id);
  assert.equal(out.planId, plan.id);
  assert.equal(out.corp.length, 0);
  assert.equal(out.personal.length, 0);
  assert.deepEqual(out.integration.byShareholder, {});
  assert.equal(out.integration.warnings.length, 0);
});

test('computeHouseholdPlan routes salary from corp scenario to personal scenario', async () => {
  const { household, personal, corp } = await seedHouseholdWithCorpAndPersonal();
  const plan = await HouseholdPlan.create({
    householdId: household.id, name: 'Salary', notes: null,
  });
  const corpBaseline = await ensureCorpBaselineScenario(corp.id, 2025);
  await Scenario.create({
    parentId: corpBaseline.id, householdPlanId: plan.id,
    entityId: corp.id, year: 2025, name: 'Salary heavy', kind: 'fork',
    overrides: {
      [`ownerComp.${personal.id}.salary`]: 60000,
      'corp.salaryPaid': 60000,
    },
    assumptions: {}, nextYearId: null, notes: null,
  });
  const personalBaseline = await ensureBaselineScenario(personal.id, 2025);
  await personalBaseline.update({ householdPlanId: plan.id });

  const out = await computeHouseholdPlan(plan.id);
  assert.equal(out.corp.length, 1);
  assert.equal(out.personal.length, 1);

  // Router should have routed the salary as employment income to the personal entity.
  const additions = out.integration.byShareholder[personal.id];
  assert.ok(additions, 'expected router output for the personal shareholder');
  assert.equal(additions.employmentIncome.toString(), '60000');
  assert.equal(additions.cppEnrolled, true);

  // Personal compute path skipped the cache (sentinel hash) and reflects the routed salary
  // as employment income on the T1 (L10100).
  assert.equal(out.personal[0].computed.factsHash, 'household-integrated');
  assert.equal(out.personal[0].computed.cached, false);
  const empLine = (out.personal[0].computed.lines as Array<{ code: string; amount: string }>)
    .find((l) => l.code === 'L10100');
  assert.ok(empLine, 'expected L10100 line on personal T1');
  // Lines are JSON-serialised, so amount is a string. Engine sums into 60000 since
  // there are no other employment txns.
  assert.equal(empLine.amount, '60000');
});

test('computeHouseholdPlan emits integration warnings for over-GRIP eligible dividends', async () => {
  const { household, personal, corp } = await seedHouseholdWithCorpAndPersonal();
  const plan = await HouseholdPlan.create({
    householdId: household.id, name: 'OverDraw', notes: null,
  });
  const corpBaseline = await ensureCorpBaselineScenario(corp.id, 2025);
  await Scenario.create({
    parentId: corpBaseline.id, householdPlanId: plan.id,
    entityId: corp.id, year: 2025, name: 'Bad', kind: 'fork',
    overrides: { [`ownerComp.${personal.id}.eligibleDividend`]: 200000 },
    assumptions: {}, nextYearId: null, notes: null,
  });
  const personalBaseline = await ensureBaselineScenario(personal.id, 2025);
  await personalBaseline.update({ householdPlanId: plan.id });

  const out = await computeHouseholdPlan(plan.id);
  assert.ok(
    out.integration.warnings.some((w) => /GRIP/.test(w.message)),
    `expected a GRIP warning, got: ${JSON.stringify(out.integration.warnings)}`,
  );
});

test('computeHouseholdPlan routes intercorp non-eligible dividend from Opco to Holdco (P11a)', async () => {
  // Seed: 1 household, 1 personal, 2 corps (Opco + Holdco). All 3 scenarios
  // linked to a HouseholdPlan. Opco's scenario distributes 80k non-eligible
  // div to Holdco via the dynamic `intercorp.<HoldcoEntityId>.nonEligible` key
  // (P11a Task 1). Expected flow:
  //   1. intercorpRouter emits a CorpReceivedDivs entry for Holdco
  //   2. Holdco's compute path injects the received div into its
  //      investmentIncome.nonEligibleDividends array (cache-skipped path)
  //   3. computeIntegration applies Part IV via NERDTOH addition:
  //      80000 × 0.3067 = 24,536
  //   4. Holdco's totals.nerdtohEnding reflects that (no dividendRefund
  //      because Holdco pays no dividends out itself)
  const household = await Household.create({ name: 'Holdco' });
  const personalEntity = await Entity.create({
    householdId: household.id, kind: 'personal', legalName: 'P',
    jurisdiction: 'CA-ON', fiscalYearEnd: null,
  });
  const opco = await Entity.create({
    householdId: household.id, kind: 'corp', legalName: 'Opco',
    jurisdiction: 'CA-ON', fiscalYearEnd: '12-31',
  });
  const holdco = await Entity.create({
    householdId: household.id, kind: 'corp', legalName: 'Holdco',
    jurisdiction: 'CA-ON', fiscalYearEnd: '12-31',
  });

  const plan = await HouseholdPlan.create({
    householdId: household.id, name: 'Holdco Flow', notes: null,
  });

  // Opco: override active income to 200k + distribute 80k non-elig div to Holdco
  const opcoBaseline = await ensureCorpBaselineScenario(opco.id, 2025);
  await Scenario.create({
    parentId: opcoBaseline.id, householdPlanId: plan.id,
    entityId: opco.id, year: 2025, name: 'Opco fork', kind: 'fork',
    overrides: {
      'corp.activeIncome': 200000,
      [`intercorp.${holdco.id}.nonEligible`]: 80000,
    },
    assumptions: {}, nextYearId: null, notes: null,
  });

  // Holdco: plain baseline linked to plan (no overrides)
  const holdcoBaseline = await ensureCorpBaselineScenario(holdco.id, 2025);
  await holdcoBaseline.update({ householdPlanId: plan.id });

  // Personal: plain baseline linked to plan (no overrides — keeps test focus on intercorp)
  const personalBaseline = await ensureBaselineScenario(personalEntity.id, 2025);
  await personalBaseline.update({ householdPlanId: plan.id });

  const out = await computeHouseholdPlan(plan.id);

  // Plan structure: 2 corp results, 1 personal result
  assert.equal(out.corp.length, 2);
  assert.equal(out.personal.length, 1);

  // intercorpRouter output: no warnings (Holdco is in plan, no self-loop)
  assert.equal(
    out.intercorp.warnings.length,
    0,
    `expected zero intercorp warnings, got: ${JSON.stringify(out.intercorp.warnings)}`,
  );

  // Holdco receives a single non-elig dividend item, no eligible / capital
  const holdcoReceived = out.intercorp.byReceiverEntityId[holdco.id];
  assert.ok(holdcoReceived, 'expected Holdco to have a received-divs entry');
  assert.equal(holdcoReceived.nonEligibleDividends.length, 1);
  assert.equal(holdcoReceived.eligibleDividends.length, 0);
  assert.equal(holdcoReceived.capitalDividends.length, 0);
  assert.equal(
    holdcoReceived.nonEligibleDividends[0].cadAmount.toFixed(2),
    '80000.00',
  );

  // Holdco's compute path bypassed the cache (sentinel hash) since it's a receiver
  const holdcoResult = out.corp.find((c) => c.scenario.entityId === holdco.id);
  assert.ok(holdcoResult, 'expected a corp result for Holdco');
  assert.equal(holdcoResult.computed.factsHash, 'household-intercorp');
  assert.equal(holdcoResult.computed.cached, false);

  // Holdco's NERDTOH ending = 80000 × 0.3067 = 24,536 (Part IV via NERDTOH addition).
  // No dividendRefund because Holdco pays no dividends out (no dividendsPaid in baseline).
  const holdcoNerdtohEnding = String(holdcoResult.computed.totals.nerdtohEnding ?? '0');
  assert.equal(holdcoNerdtohEnding, '24536');

  // Opco's compute path used the cache (it doesn't receive divs — it pays them).
  // Sanity: Opco's tax computation isn't affected by the intercorp distribution
  // (intercorp dividends are NOT deductible at the payer — they're just routed).
  const opcoResult = out.corp.find((c) => c.scenario.entityId === opco.id);
  assert.ok(opcoResult, 'expected a corp result for Opco');
  assert.notEqual(
    opcoResult.computed.factsHash,
    'household-intercorp',
    'Opco should use the cache path (not a receiver)',
  );
});
