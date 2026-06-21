import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { sequelize } from '../../db';
import {
  Account, Entity, Household, Scenario, Transaction,
} from '../../models';
import { projectPersonalFactsFromPrevYear } from './projectPersonalFactsFromPrevYear';
import { ensureBaselineScenario } from './resolveScenario';

beforeEach(async () => { await sequelize.sync({ force: true }); });

async function seedPersonalWithEmployment() {
  const household = await Household.create({ name: 'T' });
  const entity = await Entity.create({
    householdId: household.id, kind: 'personal', legalName: 'P',
    jurisdiction: 'CA-ON', fiscalYearEnd: null,
  });
  const account = await Account.create({
    name: 'Chk', householdId: household.id, accountType: 'checking',
    entityId: entity.id, taxStatus: 'non_registered', defaultCurrency: 'CAD',
  } as never);
  await Transaction.create({
    accountId: account.id, householdId: household.id, entityId: entity.id,
    date: '2025-03-15', amount: '80000', currency: 'CAD',
    finalCategory: 'employment_income',
    merchantRaw: 'E', merchantClean: 'E',
    importBatch: 'b', sourceRowFingerprint: 'fp1', sourceIdentityFingerprint: 'sif1',
  } as never);
  return { entity };
}

test('projects year+1 facts from year N actuals with zero inflation', async () => {
  const { entity } = await seedPersonalWithEmployment();
  const yearN = await ensureBaselineScenario(entity.id, 2025);
  const yearN1 = await Scenario.create({
    parentId: yearN.id, householdPlanId: null,
    entityId: entity.id, year: 2026, name: 'Projection 2026', kind: 'projection_root',
    overrides: {}, assumptions: {}, nextYearId: null, notes: null,
  });
  const facts = await projectPersonalFactsFromPrevYear(yearN1.id);
  assert.equal(facts.year, 2026);
  // Prior year had 80k employment; with inflation=0 (default) projection carries 80k.
  assert.equal(facts.employmentIncome.length, 1);
  assert.equal(facts.employmentIncome[0].cadAmount.toFixed(2), '80000.00');
});

test('applies inflation multiplier from assumptions', async () => {
  const { entity } = await seedPersonalWithEmployment();
  const yearN = await ensureBaselineScenario(entity.id, 2025);
  const yearN1 = await Scenario.create({
    parentId: yearN.id, householdPlanId: null,
    entityId: entity.id, year: 2026, name: 'Projection 2026', kind: 'projection_root',
    overrides: {}, assumptions: { inflation: 0.025 }, nextYearId: null, notes: null,
  });
  const facts = await projectPersonalFactsFromPrevYear(yearN1.id);
  // 80000 × 1.025 = 82000
  assert.equal(facts.employmentIncome[0].cadAmount.toFixed(2), '82000.00');
});

test('seeds carryforwards from prior year roll-forward', async () => {
  const { entity } = await seedPersonalWithEmployment();
  const yearN = await ensureBaselineScenario(entity.id, 2025);
  const yearN1 = await Scenario.create({
    parentId: yearN.id, householdPlanId: null,
    entityId: entity.id, year: 2026, name: 'Projection 2026', kind: 'projection_root',
    overrides: {}, assumptions: {}, nextYearId: null, notes: null,
  });
  const facts = await projectPersonalFactsFromPrevYear(yearN1.id);
  // RRSP room earned in 2025 (18% × $80k = $14,400 capped at annual limit) should appear in 2026 carryforwards.
  // The exact figure depends on rate table; assert non-zero.
  assert.ok(facts.carryforwards.rrspRoom.greaterThan(0), 'RRSP room should be projected from prior earned income');
});

test('rejects when parent is not a year-N scenario for the same entity', async () => {
  const household = await Household.create({ name: 'T' });
  const entityA = await Entity.create({
    householdId: household.id, kind: 'personal', legalName: 'A',
    jurisdiction: 'CA-ON', fiscalYearEnd: null,
  });
  const entityB = await Entity.create({
    householdId: household.id, kind: 'personal', legalName: 'B',
    jurisdiction: 'CA-ON', fiscalYearEnd: null,
  });
  const yearN = await ensureBaselineScenario(entityA.id, 2025);
  const orphan = await Scenario.create({
    parentId: yearN.id, householdPlanId: null,
    entityId: entityB.id, year: 2026, name: 'X', kind: 'projection_root',
    overrides: {}, assumptions: {}, nextYearId: null, notes: null,
  });
  await assert.rejects(() => projectPersonalFactsFromPrevYear(orphan.id), /entity mismatch|same entity/i);
});

test('rejects when scenario kind is not projection_root', async () => {
  const { entity } = await seedPersonalWithEmployment();
  const yearN = await ensureBaselineScenario(entity.id, 2025);
  await assert.rejects(() => projectPersonalFactsFromPrevYear(yearN.id), /projection_root/i);
});
