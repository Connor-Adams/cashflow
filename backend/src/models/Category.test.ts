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
  // Delete children (parentId IS NOT NULL) before roots to avoid ON DELETE SET NULL
  // collisions against the root partial-unique index.
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

test('same leaf name allowed under two different parents', async () => {
  const work = await Category.create({ householdId, name: 'Work', icon: null, parentId: null });
  const home = await Category.create({ householdId, name: 'Home', icon: null, parentId: null });
  await Category.create({ householdId, name: 'Internet', icon: null, parentId: work.id });
  await Category.create({ householdId, name: 'Internet', icon: null, parentId: home.id }); // must not throw
  const count = await Category.count({ where: { householdId, name: 'Internet' } });
  assert.equal(count, 2);
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
