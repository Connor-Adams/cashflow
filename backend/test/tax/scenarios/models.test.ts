import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { sequelize } from '../../../src/db';
import { Entity, Household, Scenario, ScenarioReturn } from '../../../src/models';

beforeEach(async () => {
  await sequelize.sync({ force: true });
});

test('creates and reads back a Scenario with overrides + assumptions JSON', async () => {
  const household = await Household.create({ name: 'T' });
  const entity = await Entity.create({
    householdId: household.id, kind: 'personal', legalName: 'P',
    jurisdiction: 'CA-ON', fiscalYearEnd: null,
  });
  const scenario = await Scenario.create({
    parentId: null, entityId: entity.id, year: 2025,
    name: 'Baseline', kind: 'baseline',
    overrides: {}, assumptions: {}, nextYearId: null, notes: null,
  });
  const reloaded = await Scenario.findByPk(scenario.id);
  assert.equal(reloaded?.name, 'Baseline');
  assert.deepEqual(reloaded?.overrides, {});
});

test('unique constraint on (entity_id, year, name)', async () => {
  const household = await Household.create({ name: 'T' });
  const entity = await Entity.create({
    householdId: household.id, kind: 'personal', legalName: 'P',
    jurisdiction: 'CA-ON', fiscalYearEnd: null,
  });
  await Scenario.create({
    parentId: null, entityId: entity.id, year: 2025, name: 'Plan A', kind: 'baseline',
    overrides: {}, assumptions: {}, nextYearId: null, notes: null,
  });
  await assert.rejects(() =>
    Scenario.create({
      parentId: null, entityId: entity.id, year: 2025, name: 'Plan A', kind: 'fork',
      overrides: {}, assumptions: {}, nextYearId: null, notes: null,
    }),
  );
});

test('cascade delete: deleting Scenario removes its ScenarioReturn cache rows', async () => {
  const household = await Household.create({ name: 'T' });
  const entity = await Entity.create({
    householdId: household.id, kind: 'personal', legalName: 'P',
    jurisdiction: 'CA-ON', fiscalYearEnd: null,
  });
  const scenario = await Scenario.create({
    parentId: null, entityId: entity.id, year: 2025, name: 'Baseline', kind: 'baseline',
    overrides: {}, assumptions: {}, nextYearId: null, notes: null,
  });
  await ScenarioReturn.create({
    scenarioId: scenario.id, factsHash: 'abc', computedAt: new Date(),
    lines: [], totals: {}, warnings: [],
  });
  await scenario.destroy();
  const remaining = await ScenarioReturn.findAll();
  assert.equal(remaining.length, 0);
});
