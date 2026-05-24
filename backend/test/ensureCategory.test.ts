import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { sequelize } from '../src/db';
import { Category, Household } from '../src/models';
import { ensureCategory } from '../src/lib/ensureCategory';

before(async () => {
  await sequelize.sync({ force: true });
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
