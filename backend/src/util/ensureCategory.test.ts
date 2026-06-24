import { before, beforeEach, after, test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_PATH = ':memory:';

let sequelize: import('sequelize').Sequelize;
let Category: typeof import('../models/Category').Category;
let Household: typeof import('../models/Household').Household;
let ensureCategory: typeof import('./ensureCategory').ensureCategory;

before(async () => {
  const models = await import('../models');
  sequelize = models.sequelize;
  Category = models.Category;
  Household = models.Household;
  const util = await import('./ensureCategory');
  ensureCategory = util.ensureCategory;
  await sequelize.sync({ force: true });
});

after(async () => {
  await sequelize.close();
});

beforeEach(async () => {
  await Category.destroy({ where: {}, truncate: true });
  await Household.destroy({ where: {}, truncate: true });
});

test('ensureCategory: inserts new (household, name) row', async () => {
  const hh = await Household.create({ name: 'H' });
  await ensureCategory(hh.id, 'Groceries');
  const rows = await Category.findAll({ where: { householdId: hh.id } });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, 'Groceries');
  assert.equal(rows[0].icon, null);
});

test('ensureCategory: trims and deduplicates', async () => {
  const hh = await Household.create({ name: 'H' });
  await ensureCategory(hh.id, '  Rent ');
  await ensureCategory(hh.id, 'Rent');
  const rows = await Category.findAll({ where: { householdId: hh.id } });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, 'Rent');
});

test('ensureCategory: ignores null/empty/whitespace', async () => {
  const hh = await Household.create({ name: 'H' });
  await ensureCategory(hh.id, null);
  await ensureCategory(hh.id, '');
  await ensureCategory(hh.id, '   ');
  const rows = await Category.findAll({ where: { householdId: hh.id } });
  assert.equal(rows.length, 0);
});

test('ensureCategory: a "Parent / Child" name resolves to nested rows, not a flat root', async () => {
  const hh = await Household.create({ name: 'H' });
  await ensureCategory(hh.id, 'Household / Vape');
  const rows = await Category.findAll({ where: { householdId: hh.id }, order: [['id', 'ASC']] });
  // exactly two rows: a "Household" root and a "Vape" child under it — never a flat
  // top-level "Household / Vape" row.
  assert.equal(rows.length, 2);
  const root = rows.find((r) => r.parentId == null);
  const child = rows.find((r) => r.parentId != null);
  assert.equal(root?.name, 'Household');
  assert.equal(child?.name, 'Vape');
  assert.equal(child?.parentId, root?.id);
  assert.equal(rows.some((r) => r.name.includes('/')), false);
});

test('ensureCategory: a path reuses existing nested categories instead of duplicating', async () => {
  const hh = await Household.create({ name: 'H' });
  const household = await Category.create({ householdId: hh.id, name: 'Household', parentId: null, icon: null });
  await Category.create({ householdId: hh.id, name: 'Vape', parentId: household.id, icon: null });
  await ensureCategory(hh.id, 'Household / Vape');
  const rows = await Category.findAll({ where: { householdId: hh.id } });
  assert.equal(rows.length, 2); // no new rows created
});

test('ensureCategory: swallows an invalid path (empty segment) without throwing or writing', async () => {
  const hh = await Household.create({ name: 'H' });
  await ensureCategory(hh.id, 'Foo / / Bar'); // empty middle segment
  const rows = await Category.findAll({ where: { householdId: hh.id } });
  assert.equal(rows.length, 0);
});

test('ensureCategory: preserves existing icon on re-upsert', async () => {
  const hh = await Household.create({ name: 'H' });
  await ensureCategory(hh.id, 'Coffee');
  const row = await Category.findOne({ where: { householdId: hh.id, name: 'Coffee' } });
  if (!row) throw new Error('row missing');
  row.set('icon', 'Coffee');
  await row.save();
  await ensureCategory(hh.id, 'Coffee');
  const after = await Category.findOne({ where: { householdId: hh.id, name: 'Coffee' } });
  assert.equal(after?.icon, 'Coffee');
});
