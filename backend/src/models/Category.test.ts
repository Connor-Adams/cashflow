import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Op } from 'sequelize';

// Use an in-memory SQLite DB; set before the models module is imported so
// db.ts picks it up before creating the Sequelize instance.
process.env.DATABASE_PATH = ':memory:';

let sequelize: import('sequelize').Sequelize;
let Category: typeof import('./Category').Category;
let Household: typeof import('./Household').Household;

before(async () => {
  const models = await import('../models');
  ({ sequelize, Category, Household } = models);
  await sequelize.sync({ force: true });
});

after(async () => {
  await sequelize.close();
});

let householdId: number;

beforeEach(async () => {
  // Delete children (parentId IS NOT NULL) before roots: the belongsTo's default
  // ON DELETE SET NULL promotes a surviving child to a root mid-delete, and a
  // promotion that collides under categories_household_name_key_unique fails the
  // delete itself.
  await Category.destroy({ where: { parentId: { [Op.ne]: null } } });
  await Category.destroy({ where: {} });
  await Household.destroy({ where: {}, truncate: true });
  const h = await Household.create({ name: 'T' });
  householdId = h.id;
});

test('sets name_key automatically from name', async () => {
  const c = await Category.create({ householdId, name: '  Groceries ', icon: null, parentId: null });
  assert.equal(c.nameKey, 'groceries');
});

/**
 * FLIPPED by migration 20260930000001-merge-duplicate-category-names.js. This
 * test used to assert the opposite — that the same leaf name was legal under two
 * different parents — because uniqueness was parent-scoped. That is exactly how
 * the nightly enrichment job forked 15 of household 1's categories into a
 * root/child pair sharing one name, and why every name-keyed consumer (budget
 * spend buckets, the `final_category` string mirror) then miscounted. Uniqueness
 * is now household-wide: one name, one node, wherever it sits in the tree.
 */
test('the same leaf name under two different parents is now rejected', async () => {
  const work = await Category.create({ householdId, name: 'Work', icon: null, parentId: null });
  const home = await Category.create({ householdId, name: 'Home', icon: null, parentId: null });
  await Category.create({ householdId, name: 'Internet', icon: null, parentId: work.id });
  await assert.rejects(
    () => Category.create({ householdId, name: 'Internet', icon: null, parentId: home.id }),
    /UNIQUE|constraint/i,
  );
  assert.equal(await Category.count({ where: { householdId, name: 'Internet' } }), 1);
});

test('the same name as a root and as a nested node is rejected', async () => {
  // The precise production shape the merge migration cleaned up: a root "Golf"
  // coexisting with "Hobbies / Golf". Neither partial index caught it.
  const hobbies = await Category.create({ householdId, name: 'Hobbies', icon: null, parentId: null });
  await Category.create({ householdId, name: 'Golf', icon: null, parentId: hobbies.id });
  await assert.rejects(
    () => Category.create({ householdId, name: 'Golf', icon: null, parentId: null }),
    /UNIQUE|constraint/i,
  );
});

test('case-insensitive sibling uniqueness rejected', async () => {
  const work = await Category.create({ householdId, name: 'Work', icon: null, parentId: null });
  await Category.create({ householdId, name: 'Internet', icon: null, parentId: work.id });
  await assert.rejects(
    () => Category.create({ householdId, name: 'INTERNET', icon: null, parentId: work.id }),
    /UNIQUE|constraint/i,
  );
});

test('two roots with same name (any casing) rejected', async () => {
  await Category.create({ householdId, name: 'Bills', icon: null, parentId: null });
  await assert.rejects(
    () => Category.create({ householdId, name: 'bills', icon: null, parentId: null }),
    /UNIQUE|constraint/i,
  );
});

test('children association resolves', async () => {
  const work = await Category.create({ householdId, name: 'Work', icon: null, parentId: null });
  await Category.create({ householdId, name: 'Internet', icon: null, parentId: work.id });
  const kids = await Category.findAll({ where: { parentId: work.id } });
  assert.equal(kids.length, 1);
  assert.equal(kids[0].name, 'Internet');
});
