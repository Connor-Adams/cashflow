import { before, beforeEach, after, test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_PATH = ':memory:';

let sequelize: import('sequelize').Sequelize;
let Household: typeof import('../models').Household;
let runAllHouseholdDetectors: typeof import('./runAllHouseholdDetectors').runAllHouseholdDetectors;

before(async () => {
  const models = await import('../models');
  sequelize = models.sequelize;
  Household = models.Household;
  ({ runAllHouseholdDetectors } = await import('./runAllHouseholdDetectors'));
  await sequelize.sync({ force: true });
});

after(async () => {
  await sequelize.close();
});

beforeEach(async () => {
  await Household.destroy({ where: {}, truncate: true });
});

test('runs detectors for every household and aggregates counts', async () => {
  const a = await Household.create({ name: 'A' });
  const b = await Household.create({ name: 'B' });
  const seen: number[] = [];

  const result = await runAllHouseholdDetectors({
    runForHousehold: async (householdId) => {
      seen.push(householdId);
      return { created: 2, refreshed: 1, resolved: 3, total: 3, detectorCounts: {} };
    },
  });

  assert.deepEqual(seen.sort((x, y) => x - y), [a.id, b.id].sort((x, y) => x - y));
  assert.equal(result.households, 2);
  assert.equal(result.succeeded, 2);
  assert.equal(result.failed, 0);
  assert.equal(result.created, 4);
  assert.equal(result.refreshed, 2);
  assert.equal(result.resolved, 6);
  assert.deepEqual(result.errors, []);
});

test('one household failing does not abort the others', async () => {
  const a = await Household.create({ name: 'A' });
  const b = await Household.create({ name: 'B' });

  const result = await runAllHouseholdDetectors({
    runForHousehold: async (householdId) => {
      if (householdId === a.id) throw new Error('boom');
      return { created: 1, refreshed: 0, resolved: 0, total: 1, detectorCounts: {} };
    },
  });

  assert.equal(result.households, 2);
  assert.equal(result.succeeded, 1);
  assert.equal(result.failed, 1);
  assert.equal(result.created, 1);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].householdId, a.id);
  assert.match(result.errors[0].message, /boom/);
});
