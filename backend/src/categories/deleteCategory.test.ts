import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { sequelize } from '../db';
import { Category, Household } from '../models';
import { deleteCategory } from './deleteCategory';
import { CategoryError } from './errors';

let householdId: number;

beforeEach(async () => {
  await sequelize.sync({ force: true });
  householdId = (await Household.create({ name: 'T' })).id;
});

test('deletes a leaf node', async () => {
  const leaf = await Category.create({ householdId, name: 'Snacks', icon: null, parentId: null });
  await deleteCategory(householdId, leaf.id);
  assert.equal(await Category.findByPk(leaf.id), null);
});

test('blocks deleting a node that has children', async () => {
  const parent = await Category.create({ householdId, name: 'Groceries', icon: null, parentId: null });
  await Category.create({ householdId, name: 'Produce', icon: null, parentId: parent.id });
  await assert.rejects(
    () => deleteCategory(householdId, parent.id),
    (e: unknown) => e instanceof CategoryError && e.code === 'has_children',
  );
  assert.notEqual(await Category.findByPk(parent.id), null);
});

test('rejects unknown node', async () => {
  await assert.rejects(
    () => deleteCategory(householdId, 424242),
    (e: unknown) => e instanceof CategoryError && e.code === 'not_found',
  );
});
