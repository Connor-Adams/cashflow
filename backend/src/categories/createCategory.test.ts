// backend/src/categories/createCategory.test.ts
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { sequelize } from '../db';
import { Category, Household } from '../models';
import { createCategory } from './createCategory';
import { CategoryError } from './errors';

let householdId: number;
let otherHouseholdId: number;

beforeEach(async () => {
  await sequelize.sync({ force: true });
  householdId = (await Household.create({ name: 'H1' })).id;
  otherHouseholdId = (await Household.create({ name: 'H2' })).id;
});

test('creates a root category (parentId null)', async () => {
  const cat = await createCategory(householdId, 'Groceries', null);
  assert.equal(cat.name, 'Groceries');
  assert.equal(cat.parentId, null);
  assert.equal(cat.householdId, householdId);
});

test('creates a child category under an existing parent', async () => {
  const parent = await Category.create({ householdId, name: 'Work', icon: null, parentId: null });
  const child = await createCategory(householdId, 'Internet', parent.id);
  assert.equal(child.name, 'Internet');
  assert.equal(child.parentId, parent.id);
});

test('rejects a parentId that belongs to a different household (parent_not_found)', async () => {
  const foreignParent = await Category.create({
    householdId: otherHouseholdId,
    name: 'Other',
    icon: null,
    parentId: null,
  });
  await assert.rejects(
    () => createCategory(householdId, 'Child', foreignParent.id),
    (e: unknown) => e instanceof CategoryError && e.code === 'parent_not_found',
  );
});

test('rejects a duplicate sibling name case-insensitively (sibling_conflict)', async () => {
  const parent = await Category.create({ householdId, name: 'Work', icon: null, parentId: null });
  await createCategory(householdId, 'Internet', parent.id);
  await assert.rejects(
    () => createCategory(householdId, 'INTERNET', parent.id),
    (e: unknown) => e instanceof CategoryError && e.code === 'sibling_conflict',
  );
});

test('allows the same name under two different parents', async () => {
  const work = await Category.create({ householdId, name: 'Work', icon: null, parentId: null });
  const home = await Category.create({ householdId, name: 'Home', icon: null, parentId: null });
  await createCategory(householdId, 'Internet', work.id);
  // should NOT throw
  const c = await createCategory(householdId, 'Internet', home.id);
  assert.equal(c.name, 'Internet');
  assert.equal(c.parentId, home.id);
});
