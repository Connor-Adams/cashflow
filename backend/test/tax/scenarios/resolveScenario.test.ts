import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { sequelize } from '../../../src/db';
import {
  Account, Entity, Household, Scenario, Transaction,
} from '../../../src/models';
import { resolveScenario, ensureBaselineScenario } from '../../../src/tax/scenarios/resolveScenario';

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

test('ensureBaselineScenario creates a baseline row on first call, returns existing on second', async () => {
  const { entity } = await seedEntity();
  const first = await ensureBaselineScenario(entity.id, 2025);
  assert.equal(first.kind, 'baseline');
  assert.equal(first.name, 'Baseline');

  const second = await ensureBaselineScenario(entity.id, 2025);
  assert.equal(second.id, first.id);
  assert.equal((await Scenario.count()), 1);
});

test('resolveScenario(baseline) returns facts built from actuals', async () => {
  const { entity } = await seedEntity();
  const baseline = await ensureBaselineScenario(entity.id, 2025);
  const facts = await resolveScenario(baseline.id);
  assert.equal(facts.employmentIncome.length, 1);
  assert.equal(facts.employmentIncome[0].cadAmount.toFixed(2), '80000.00');
});

test('resolveScenario(fork) layers override on top of baseline actuals', async () => {
  const { entity } = await seedEntity();
  const baseline = await ensureBaselineScenario(entity.id, 2025);
  const fork = await Scenario.create({
    parentId: baseline.id, householdPlanId: null, entityId: entity.id, year: 2025,
    name: 'High salary', kind: 'fork',
    overrides: { 'income.employment': 120000 },
    assumptions: {}, nextYearId: null, notes: null,
  });
  const facts = await resolveScenario(fork.id);
  assert.equal(facts.employmentIncome.length, 1);
  assert.equal(facts.employmentIncome[0].cadAmount.toFixed(2), '120000.00');
});

test('resolveScenario walks multi-level ancestry (baseline -> fork1 -> fork2)', async () => {
  const { entity } = await seedEntity();
  const baseline = await ensureBaselineScenario(entity.id, 2025);
  const fork1 = await Scenario.create({
    parentId: baseline.id, householdPlanId: null, entityId: entity.id, year: 2025,
    name: 'L1', kind: 'fork',
    overrides: { 'income.employment': 90000 },
    assumptions: {}, nextYearId: null, notes: null,
  });
  const fork2 = await Scenario.create({
    parentId: fork1.id, householdPlanId: null, entityId: entity.id, year: 2025,
    name: 'L2', kind: 'fork',
    overrides: { 'deductions.rrspContrib': 25000 },
    assumptions: {}, nextYearId: null, notes: null,
  });
  const facts = await resolveScenario(fork2.id);
  assert.equal(facts.employmentIncome[0].cadAmount.toFixed(2), '90000.00');
  assert.equal(facts.rrspContribs.length, 1);
  assert.equal(facts.rrspContribs[0].amount.toFixed(2), '25000.00');
});

test('resolveScenario(fork on projection_root) layers overrides on projected facts', async () => {
  const { entity } = await seedEntity();
  const yearN = await ensureBaselineScenario(entity.id, 2025);
  const yearN1Root = await Scenario.create({
    parentId: yearN.id, householdPlanId: null,
    entityId: entity.id, year: 2026, name: 'Projection', kind: 'projection_root',
    overrides: {}, assumptions: { inflation: 0.025 }, nextYearId: null, notes: null,
  });
  const fork = await Scenario.create({
    parentId: yearN1Root.id, householdPlanId: null,
    entityId: entity.id, year: 2026, name: 'High salary 2026', kind: 'fork',
    overrides: { 'income.employment': 100000 },
    assumptions: {}, nextYearId: null, notes: null,
  });
  const facts = await resolveScenario(fork.id);
  // override wins, replaces inflated 82k with 100k
  assert.equal(facts.employmentIncome.length, 1);
  assert.equal(facts.employmentIncome[0].cadAmount.toFixed(2), '100000.00');
  // year reflects projection_root year, not parent year
  assert.equal(facts.year, 2026);
});

test('resolveScenario throws on cyclic ancestry', async () => {
  // Build a cycle: a -> b -> a (only possible via raw update bypassing our APIs).
  const { entity } = await seedEntity();
  const a = await Scenario.create({
    parentId: null, householdPlanId: null, entityId: entity.id, year: 2025, name: 'A', kind: 'fork',
    overrides: {}, assumptions: {}, nextYearId: null, notes: null,
  });
  const b = await Scenario.create({
    parentId: a.id, householdPlanId: null, entityId: entity.id, year: 2025, name: 'B', kind: 'fork',
    overrides: {}, assumptions: {}, nextYearId: null, notes: null,
  });
  await a.update({ parentId: b.id });
  await assert.rejects(() => resolveScenario(a.id), /cycle/i);
});
