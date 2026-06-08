// backend/test/tax/scenarios/resolveCorpScenario.test.ts
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { sequelize } from '../../db';
import {
  Account, Entity, Household, Scenario, Transaction,
} from '../../models';
import { resolveCorpScenario, ensureCorpBaselineScenario } from './resolveCorpScenario';

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
    parentId: baseline.id, householdPlanId: null, entityId: entity.id, year: 2025,
    name: 'Higher revenue', kind: 'fork',
    overrides: { 'corp.activeIncome': 400000 },
    assumptions: {}, nextYearId: null, notes: null,
  });
  const facts = await resolveCorpScenario(fork.id);
  assert.equal(facts.activeBusinessIncome.length, 1);
  assert.equal(facts.activeBusinessIncome[0].cadAmount.toFixed(2), '400000.00');
});

test('resolveCorpScenario(fork on projection_root) layers overrides on projected facts', async () => {
  const { entity } = await seedCorp();
  const yearN = await ensureCorpBaselineScenario(entity.id, 2025);
  const yearN1Root = await Scenario.create({
    parentId: yearN.id, householdPlanId: null,
    entityId: entity.id, year: 2026, name: 'Projection', kind: 'projection_root',
    overrides: {}, assumptions: { inflation: 0.025 }, nextYearId: null, notes: null,
  });
  const fork = await Scenario.create({
    parentId: yearN1Root.id, householdPlanId: null,
    entityId: entity.id, year: 2026, name: 'Higher revenue 2026', kind: 'fork',
    overrides: { 'corp.activeIncome': 400000 },
    assumptions: {}, nextYearId: null, notes: null,
  });
  const facts = await resolveCorpScenario(fork.id);
  // override wins, replaces inflated 256.25k with 400k
  assert.equal(facts.activeBusinessIncome.length, 1);
  assert.equal(facts.activeBusinessIncome[0].cadAmount.toFixed(2), '400000.00');
  // fiscal year reflects projection_root year, not parent year
  assert.equal(facts.fiscalYear.startDate, '2026-01-01');
  assert.equal(facts.fiscalYear.endDate, '2026-12-31');
});

test('resolveCorpScenario rejects when scenario entity is personal', async () => {
  const household = await Household.create({ name: 'T2' });
  const personal = await Entity.create({
    householdId: household.id, kind: 'personal', legalName: 'P',
    jurisdiction: 'CA-ON', fiscalYearEnd: null,
  });
  const scenario = await Scenario.create({
    parentId: null, householdPlanId: null, entityId: personal.id, year: 2025,
    name: 'Wrong kind', kind: 'baseline',
    overrides: {}, assumptions: {}, nextYearId: null, notes: null,
  });
  await assert.rejects(() => resolveCorpScenario(scenario.id), /personal/i);
});
