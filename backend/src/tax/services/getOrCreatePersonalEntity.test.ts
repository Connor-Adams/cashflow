import { before, beforeEach, after, test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_PATH = ':memory:';

let sequelize: import('sequelize').Sequelize;
let Entity: typeof import('../../models/Entity').Entity;
let Household: typeof import('../../models/Household').Household;
let getOrCreatePersonalEntity: typeof import('./getOrCreatePersonalEntity').getOrCreatePersonalEntity;

before(async () => {
  const models = await import('../../models');
  sequelize = models.sequelize;
  Entity = models.Entity;
  Household = models.Household;
  ({ getOrCreatePersonalEntity } = await import('./getOrCreatePersonalEntity'));
  await sequelize.sync({ force: true });
});
after(async () => { await sequelize.close(); });

let householdId: number;
beforeEach(async () => {
  await Entity.destroy({ where: {}, truncate: true });
  await Household.destroy({ where: {}, truncate: true });
  householdId = (await Household.create({ name: 'H' })).id;
});

test('creates a personal entity when none exists', async () => {
  const e = await getOrCreatePersonalEntity(householdId);
  assert.equal(e.kind, 'personal');
  assert.equal(e.householdId, householdId);
  assert.equal(e.legalName, 'Personal');
  assert.equal(await Entity.count({ where: { householdId, kind: 'personal' } }), 1);
});

test('is idempotent — reuses the existing personal entity', async () => {
  const first = await getOrCreatePersonalEntity(householdId);
  const second = await getOrCreatePersonalEntity(householdId);
  assert.equal(first.id, second.id);
  assert.equal(await Entity.count({ where: { householdId, kind: 'personal' } }), 1);
});

test('does not return a corp entity', async () => {
  await Entity.create({ householdId, kind: 'corp', legalName: 'Acme Inc.' });
  const e = await getOrCreatePersonalEntity(householdId);
  assert.equal(e.kind, 'personal');
});
