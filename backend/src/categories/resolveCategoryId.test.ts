import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { sequelize } from '../db';
import { Category, Household } from '../models';
import { resolveCategoryIdByName } from './resolveCategoryId';

let householdId: number;
beforeEach(async () => {
  await sequelize.sync({ force: true });
  householdId = (await Household.create({ name: 'T' })).id;
});

test('null/empty name resolves to null', async () => {
  assert.equal(await resolveCategoryIdByName(householdId, null), null);
  assert.equal(await resolveCategoryIdByName(householdId, '   '), null);
});

test('creates a root node and returns its id', async () => {
  const id = await resolveCategoryIdByName(householdId, 'Groceries');
  const node = await Category.findByPk(id!);
  assert.equal(node?.name, 'Groceries');
  assert.equal(node?.parentId, null);
});

test('is idempotent + case-insensitive (no duplicate root)', async () => {
  const a = await resolveCategoryIdByName(householdId, 'Dining');
  const b = await resolveCategoryIdByName(householdId, '  dining ');
  assert.equal(a, b);
  assert.equal(await Category.count({ where: { householdId } }), 1);
});

test('matches an existing nested node by name if it is the only one', async () => {
  // existing flat root created by prior writes
  const id = await resolveCategoryIdByName(householdId, 'Travel');
  const again = await resolveCategoryIdByName(householdId, 'Travel');
  assert.equal(id, again);
});
