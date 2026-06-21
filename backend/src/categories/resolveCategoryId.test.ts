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

test('reuses an existing nested node by name instead of forking a duplicate root', async () => {
  // A category that was once a root and has since been nested under a parent.
  const dining = await Category.create({ householdId, name: 'Dining', parentId: null });
  const coffee = await Category.create({ householdId, name: 'Coffee', parentId: dining.id });

  const resolved = await resolveCategoryIdByName(householdId, 'Coffee');
  assert.equal(resolved, coffee.id, 'should reuse the nested Coffee, not create a root');
  // no duplicate root Coffee was created
  assert.equal(await Category.count({ where: { householdId, parentId: null, name: 'Coffee' } }), 0);
  assert.equal(await Category.count({ where: { householdId } }), 2);
});

test('prefers an existing root over a same-named nested node', async () => {
  const rootCoffee = await Category.create({ householdId, name: 'Coffee', parentId: null });
  const dining = await Category.create({ householdId, name: 'Dining', parentId: null });
  await Category.create({ householdId, name: 'Coffee', parentId: dining.id });

  assert.equal(await resolveCategoryIdByName(householdId, 'Coffee'), rootCoffee.id);
});

test('creates a root when the name is ambiguous (multiple nested, no root)', async () => {
  const a = await Category.create({ householdId, name: 'Parent A', parentId: null });
  const b = await Category.create({ householdId, name: 'Parent B', parentId: null });
  await Category.create({ householdId, name: 'Coffee', parentId: a.id });
  await Category.create({ householdId, name: 'Coffee', parentId: b.id });

  const resolved = await resolveCategoryIdByName(householdId, 'Coffee');
  const node = await Category.findByPk(resolved!);
  assert.equal(node?.parentId, null, 'ambiguous → deterministic new root');
  assert.equal(await Category.count({ where: { householdId, name: 'Coffee' } }), 3);
});
