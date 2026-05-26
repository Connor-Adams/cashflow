import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { sequelize } from '../../../src/db';
import {
  Account, Entity, Household, Scenario, Transaction,
} from '../../../src/models';
import { projectCorpFactsFromPrevYear } from '../../../src/tax/scenarios/projectCorpFactsFromPrevYear';
import { ensureCorpBaselineScenario } from '../../../src/tax/scenarios/resolveCorpScenario';

beforeEach(async () => { await sequelize.sync({ force: true }); });

async function seedCorpWithRevenue() {
  const household = await Household.create({ name: 'T' });
  const entity = await Entity.create({
    householdId: household.id, kind: 'corp', legalName: 'C',
    jurisdiction: 'CA-ON', fiscalYearEnd: '12-31',
  });
  const account = await Account.create({
    name: 'CorpChk', householdId: household.id, accountType: 'checking',
    entityId: entity.id, taxStatus: 'non_registered', defaultCurrency: 'CAD',
  } as never);
  await Transaction.create({
    accountId: account.id, householdId: household.id, entityId: entity.id,
    date: '2025-03-15', amount: '250000', currency: 'CAD',
    finalCategory: 'business_revenue', finalBusiness: true,
    merchantRaw: 'CUSTOMER', merchantClean: 'CUSTOMER',
    importBatch: 'b', sourceRowFingerprint: 'fp1', sourceIdentityFingerprint: 'sif1',
  } as never);
  return { entity };
}

test('projects year+1 corp facts from year N actuals with zero inflation', async () => {
  const { entity } = await seedCorpWithRevenue();
  const yearN = await ensureCorpBaselineScenario(entity.id, 2025);
  const yearN1 = await Scenario.create({
    parentId: yearN.id, householdPlanId: null,
    entityId: entity.id, year: 2026, name: 'Projection 2026', kind: 'projection_root',
    overrides: {}, assumptions: {}, nextYearId: null, notes: null,
  });
  const facts = await projectCorpFactsFromPrevYear(yearN1.id);
  assert.equal(facts.fiscalYear.startDate, '2026-01-01');
  assert.equal(facts.fiscalYear.endDate, '2026-12-31');
  // Prior year had 250k ABI; with inflation=0 (default) projection carries 250k.
  assert.equal(facts.activeBusinessIncome.length, 1);
  assert.equal(facts.activeBusinessIncome[0].cadAmount.toFixed(2), '250000.00');
});

test('applies inflation multiplier from assumptions', async () => {
  const { entity } = await seedCorpWithRevenue();
  const yearN = await ensureCorpBaselineScenario(entity.id, 2025);
  const yearN1 = await Scenario.create({
    parentId: yearN.id, householdPlanId: null,
    entityId: entity.id, year: 2026, name: 'Projection 2026', kind: 'projection_root',
    overrides: {}, assumptions: { inflation: 0.025 }, nextYearId: null, notes: null,
  });
  const facts = await projectCorpFactsFromPrevYear(yearN1.id);
  // 250000 × 1.025 = 256250
  assert.equal(facts.activeBusinessIncome[0].cadAmount.toFixed(2), '256250.00');
});

test('seeds carryforwards from prior year roll-forward (grip/cda/erdtoh/nerdtoh)', async () => {
  const { entity } = await seedCorpWithRevenue();
  const yearN = await ensureCorpBaselineScenario(entity.id, 2025);
  const yearN1 = await Scenario.create({
    parentId: yearN.id, householdPlanId: null,
    entityId: entity.id, year: 2026, name: 'Projection 2026', kind: 'projection_root',
    overrides: {}, assumptions: {}, nextYearId: null, notes: null,
  });
  const facts = await projectCorpFactsFromPrevYear(yearN1.id);
  // rollCorpCarryforwards writes 4 rows (grip/cda/erdtoh/nerdtoh) for asOfYear=2025;
  // projection picks them up. Verify the carryforwards object has all 4 fields
  // and the empty/initial corp starts with zero balances after one year of pure ABI.
  assert.ok(facts.carryforwards.grip.greaterThanOrEqualTo(0), 'grip should be present');
  assert.ok(facts.carryforwards.cda.greaterThanOrEqualTo(0), 'cda should be present');
  assert.ok(facts.carryforwards.erdtoh.greaterThanOrEqualTo(0), 'erdtoh should be present');
  assert.ok(facts.carryforwards.nerdtoh.greaterThanOrEqualTo(0), 'nerdtoh should be present');
  // GRIP should grow when corp earns general-rate income (above SBD limit).
  // Pure $250k ABI is below $500k SBD limit so GRIP addition is 0; just assert
  // the field is wired through from the rolled DB rows.
  assert.equal(facts.carryforwards.grip.toFixed(2), '0.00');
});

test('rejects when parent is not a year-N scenario for the same entity', async () => {
  const household = await Household.create({ name: 'T' });
  const entityA = await Entity.create({
    householdId: household.id, kind: 'corp', legalName: 'A',
    jurisdiction: 'CA-ON', fiscalYearEnd: '12-31',
  });
  const entityB = await Entity.create({
    householdId: household.id, kind: 'corp', legalName: 'B',
    jurisdiction: 'CA-ON', fiscalYearEnd: '12-31',
  });
  const yearN = await ensureCorpBaselineScenario(entityA.id, 2025);
  const orphan = await Scenario.create({
    parentId: yearN.id, householdPlanId: null,
    entityId: entityB.id, year: 2026, name: 'X', kind: 'projection_root',
    overrides: {}, assumptions: {}, nextYearId: null, notes: null,
  });
  await assert.rejects(() => projectCorpFactsFromPrevYear(orphan.id), /entity mismatch|same entity/i);
});

test('rejects when scenario kind is not projection_root', async () => {
  const { entity } = await seedCorpWithRevenue();
  const yearN = await ensureCorpBaselineScenario(entity.id, 2025);
  await assert.rejects(() => projectCorpFactsFromPrevYear(yearN.id), /projection_root/i);
});
