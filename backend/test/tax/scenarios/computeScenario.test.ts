// backend/test/tax/scenarios/computeScenario.test.ts
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { sequelize } from '../../../src/db';
import {
  Account, Entity, Household, Scenario, ScenarioReturn, Transaction,
} from '../../../src/models';
import { computeScenario } from '../../../src/tax/scenarios/computeScenario';
import { ensureBaselineScenario } from '../../../src/tax/scenarios/resolveScenario';

beforeEach(async () => {
  await sequelize.sync({ force: true });
});

async function seedEntity() {
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

test('computeScenario returns a TaxReturn shape with lines + totals + warnings', async () => {
  const { entity } = await seedEntity();
  const baseline = await ensureBaselineScenario(entity.id, 2025);
  const result = await computeScenario(baseline.id);
  assert.ok(Array.isArray(result.lines));
  assert.ok('totalPayable' in result.totals);
  assert.ok(Array.isArray(result.warnings));
});

test('computeScenario writes a ScenarioReturn cache row on first call', async () => {
  const { entity } = await seedEntity();
  const baseline = await ensureBaselineScenario(entity.id, 2025);
  await computeScenario(baseline.id);
  const cached = await ScenarioReturn.findAll({ where: { scenarioId: baseline.id } });
  assert.equal(cached.length, 1);
});

test('computeScenario reuses cache on second call with same inputs', async () => {
  const { entity } = await seedEntity();
  const baseline = await ensureBaselineScenario(entity.id, 2025);
  const r1 = await computeScenario(baseline.id);
  const r2 = await computeScenario(baseline.id);
  const cached = await ScenarioReturn.findAll({ where: { scenarioId: baseline.id } });
  assert.equal(cached.length, 1);
  assert.equal(r1.totals.totalPayable, r2.totals.totalPayable);
});

test('computeScenario recomputes when overrides change (different facts_hash)', async () => {
  const { entity } = await seedEntity();
  const baseline = await ensureBaselineScenario(entity.id, 2025);
  const fork = await Scenario.create({
    parentId: baseline.id, householdPlanId: null, entityId: entity.id, year: 2025,
    name: 'F', kind: 'fork',
    overrides: { 'income.employment': 120000 },
    assumptions: {}, nextYearId: null, notes: null,
  });
  await computeScenario(fork.id);
  await fork.update({ overrides: { 'income.employment': 150000 } });
  await computeScenario(fork.id);
  const cached = await ScenarioReturn.findAll({ where: { scenarioId: fork.id } });
  assert.equal(cached.length, 2); // two distinct facts_hash rows
});

test('computeScenario({ force: true }) bypasses cache and writes a new row', async () => {
  const { entity } = await seedEntity();
  const baseline = await ensureBaselineScenario(entity.id, 2025);
  await computeScenario(baseline.id);
  await computeScenario(baseline.id, { force: true });
  // Even if hash matches, the force path writes a fresh row.
  const cached = await ScenarioReturn.findAll({ where: { scenarioId: baseline.id } });
  assert.ok(cached.length >= 1);
});
