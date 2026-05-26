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

test('computeHouseholdPlan applies pension split between two linked spouses', async () => {
  // Seed a household with two personal entities A + B; link them as spouses.
  const household = await Household.create({ name: 'SpousePair' });
  const a = await Entity.create({
    householdId: household.id, kind: 'personal', legalName: 'A',
    jurisdiction: 'CA-ON', fiscalYearEnd: null,
  });
  const b = await Entity.create({
    householdId: household.id, kind: 'personal', legalName: 'B',
    jurisdiction: 'CA-ON', fiscalYearEnd: null,
  });
  await a.update({ spouseEntityId: b.id });
  await b.update({ spouseEntityId: a.id });

  const plan = await HouseholdPlan.create({
    householdId: household.id, name: 'PensionSplit', notes: null,
  });

  // A scenario: $120k employment income + $30k pension split transferred out.
  // (Engine doesn't distinguish pension from employment in v1; we use
  // employment as the split source per plan's spec.)
  const aBaseline = await ensureBaselineScenario(a.id, 2025);
  await Scenario.create({
    parentId: aBaseline.id, householdPlanId: plan.id,
    entityId: a.id, year: 2025, name: 'A with split', kind: 'fork',
    overrides: {
      'income.employment': 120000,
      'pensionSplit.transferAmount': 30000,
    },
    assumptions: {}, nextYearId: null, notes: null,
  });

  // B scenario: plain baseline linked to plan (no overrides).
  const bBaseline = await ensureBaselineScenario(b.id, 2025);
  await bBaseline.update({ householdPlanId: plan.id });

  const out = await computeHouseholdPlan(plan.id);

  // No missing-spouse warnings (spouse is linked + present in plan).
  assert.equal(
    out.spouse.warnings.length, 0,
    `expected no spouse warnings, got: ${JSON.stringify(out.spouse.warnings)}`,
  );

  // spouseRouter output records the shifts cleanly per entity.
  assert.equal(out.spouse.byEntityId[a.id]?.pensionSplitTransferOut.toFixed(2), '30000.00');
  assert.equal(out.spouse.byEntityId[a.id]?.pensionSplitTransferIn.toFixed(2), '0.00');
  assert.equal(out.spouse.byEntityId[b.id]?.pensionSplitTransferOut.toFixed(2), '0.00');
  assert.equal(out.spouse.byEntityId[b.id]?.pensionSplitTransferIn.toFixed(2), '30000.00');

  // Both personals compute via the integrated (non-cached) path because shifts apply.
  assert.equal(out.personal.length, 2);
  const aResult = out.personal.find((p) => p.scenario.entityId === a.id)!;
  const bResult = out.personal.find((p) => p.scenario.entityId === b.id)!;
  assert.equal(aResult.computed.factsHash, 'household-integrated');
  assert.equal(bResult.computed.factsHash, 'household-integrated');

  // A's L10100 = 120k − 30k = 90k after the split shift; B's = 0 + 30k.
  const aEmp = (aResult.computed.lines as Array<{ code: string; amount: string }>)
    .find((l) => l.code === 'L10100');
  const bEmp = (bResult.computed.lines as Array<{ code: string; amount: string }>)
    .find((l) => l.code === 'L10100');
  assert.ok(aEmp, 'expected L10100 on A');
  assert.ok(bEmp, 'expected L10100 on B');
  assert.equal(aEmp.amount, '90000');
  assert.equal(bEmp.amount, '30000');
});
