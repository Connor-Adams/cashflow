// backend/test/tax/scenarios/computeCorpScenario.test.ts
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { sequelize } from '../../../src/db';
import {
  Account, Entity, Household, Scenario, ScenarioReturn, Transaction,
} from '../../../src/models';
import { computeCorpScenario } from '../../../src/tax/scenarios/computeCorpScenario';
import { ensureCorpBaselineScenario } from '../../../src/tax/scenarios/resolveCorpScenario';

beforeEach(async () => {
  await sequelize.sync({ force: true });
});

async function seedCorp() {
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
    merchantRaw: 'C', merchantClean: 'C',
    importBatch: 'b', sourceRowFingerprint: 'fp1', sourceIdentityFingerprint: 'sif1',
  } as never);
  return { entity };
}

test('computeCorpScenario returns a CorpTaxReturn-shape result', async () => {
  const { entity } = await seedCorp();
  const baseline = await ensureCorpBaselineScenario(entity.id, 2025);
  const result = await computeCorpScenario(baseline.id);
  assert.ok(Array.isArray(result.lines));
  assert.ok('netTaxPayable' in result.totals);
});

test('computeCorpScenario writes a cache row and reuses it', async () => {
  const { entity } = await seedCorp();
  const baseline = await ensureCorpBaselineScenario(entity.id, 2025);
  await computeCorpScenario(baseline.id);
  await computeCorpScenario(baseline.id);
  const cached = await ScenarioReturn.findAll({ where: { scenarioId: baseline.id } });
  assert.equal(cached.length, 1);
});

test('computeCorpScenario recomputes when overrides change', async () => {
  const { entity } = await seedCorp();
  const baseline = await ensureCorpBaselineScenario(entity.id, 2025);
  const fork = await Scenario.create({
    parentId: baseline.id, householdPlanId: null, entityId: entity.id, year: 2025,
    name: 'F', kind: 'fork',
    overrides: { 'corp.activeIncome': 400000 },
    assumptions: {}, nextYearId: null, notes: null,
  });
  const r1 = await computeCorpScenario(fork.id);
  await fork.update({ overrides: { 'corp.activeIncome': 600000 } });
  const r2 = await computeCorpScenario(fork.id);
  assert.notEqual(r1.factsHash, r2.factsHash);
});
