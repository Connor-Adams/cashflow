// backend/test/tax/scenarios/resolveCorpScenario.test.ts
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { sequelize } from '../../../src/db';
import {
  Account, Entity, Household, Scenario, Transaction,
} from '../../../src/models';
import { resolveCorpScenario, ensureCorpBaselineScenario } from '../../../src/tax/scenarios/resolveCorpScenario';

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
    merchantRaw: 'CUSTOMER', merchantClean: 'CUSTOMER',
    importBatch: 'b', sourceRowFingerprint: 'fp1', sourceIdentityFingerprint: 'sif1',
  } as never);
  return { entity };
}

test('ensureCorpBaselineScenario creates a corp baseline on first call', async () => {
  const { entity } = await seedCorp();
  const baseline = await ensureCorpBaselineScenario(entity.id, 2025);
  assert.equal(baseline.kind, 'baseline');
  assert.equal(baseline.entityId, entity.id);
});

test('resolveCorpScenario(baseline) returns corp facts from actuals', async () => {
  const { entity } = await seedCorp();
  const baseline = await ensureCorpBaselineScenario(entity.id, 2025);
  const facts = await resolveCorpScenario(baseline.id);
  assert.equal(facts.activeBusinessIncome.length, 1);
  assert.equal(facts.activeBusinessIncome[0].cadAmount.toFixed(2), '250000.00');
});

test('resolveCorpScenario(fork) layers corp override on baseline actuals', async () => {
  const { entity } = await seedCorp();
  const baseline = await ensureCorpBaselineScenario(entity.id, 2025);
  const fork = await Scenario.create({
    parentId: baseline.id, entityId: entity.id, year: 2025,
    name: 'Higher revenue', kind: 'fork',
    overrides: { 'corp.activeIncome': 400000 },
    assumptions: {}, nextYearId: null, notes: null,
  });
  const facts = await resolveCorpScenario(fork.id);
  assert.equal(facts.activeBusinessIncome.length, 1);
  assert.equal(facts.activeBusinessIncome[0].cadAmount.toFixed(2), '400000.00');
});

test('resolveCorpScenario rejects when scenario entity is personal', async () => {
  const household = await Household.create({ name: 'T2' });
  const personal = await Entity.create({
    householdId: household.id, kind: 'personal', legalName: 'P',
    jurisdiction: 'CA-ON', fiscalYearEnd: null,
  });
  const scenario = await Scenario.create({
    parentId: null, entityId: personal.id, year: 2025,
    name: 'Wrong kind', kind: 'baseline',
    overrides: {}, assumptions: {}, nextYearId: null, notes: null,
  });
  await assert.rejects(() => resolveCorpScenario(scenario.id), /personal/i);
});
