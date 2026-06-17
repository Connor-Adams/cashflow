// backend/src/categories/reparent.test.ts
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { sequelize } from '../db';
import { Category, Household } from '../models';
import { reparentCategory } from './reparent';
import { CategoryError } from './errors';

let householdId: number;
let work: Category, expenses: Category, home: Category;

beforeEach(async () => {
  await sequelize.sync({ force: true });
  householdId = (await Household.create({ name: 'T' })).id;
  work = await Category.create({ householdId, name: 'Work', icon: null, parentId: null });
  expenses = await Category.create({ householdId, name: 'Expenses', icon: null, parentId: work.id });
  home = await Category.create({ householdId, name: 'Home', icon: null, parentId: null });
});

test('moves a node under a new parent', async () => {
  const moved = await reparentCategory(householdId, expenses.id, home.id);
  assert.equal(moved.parentId, home.id);
});

test('moving a node to root sets parentId null', async () => {
  const moved = await reparentCategory(householdId, expenses.id, null);
  assert.equal(moved.parentId, null);
});

test('rejects a cycle', async () => {
  await assert.rejects(
    () => reparentCategory(householdId, work.id, expenses.id),
    (e: unknown) => e instanceof CategoryError && e.code === 'cycle',
  );
});

test('rejects a sibling name collision under the new parent', async () => {
  // home already has a child "Expenses" (case variant) -> collision when moving work's Expenses under home
  await Category.create({ householdId, name: 'expenses', icon: null, parentId: home.id });
  await assert.rejects(
    () => reparentCategory(householdId, expenses.id, home.id),
    (e: unknown) => e instanceof CategoryError && e.code === 'sibling_conflict',
  );
});

test('rejects unknown node', async () => {
  await assert.rejects(
    () => reparentCategory(householdId, 999999, home.id),
    (e: unknown) => e instanceof CategoryError && e.code === 'not_found',
  );
});
