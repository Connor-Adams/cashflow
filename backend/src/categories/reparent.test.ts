// backend/src/categories/reparent.test.ts
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { sequelize } from '../db';
import { Category, Household } from '../models';
import { reparentCategory } from './reparent';
import { CategoryError } from './errors';
import { allowDuplicateCategoryNames } from './duplicateNameFixture.testHelper';

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

test('rejects a name collision anywhere in the household, not just under the new parent', async () => {
  // A third, unrelated branch ("Family") already has a same-named "expenses"
  // (case variant) — NOT under the new parent (home) and NOT under the old
  // parent (work). The old parentId-scoped check would have missed this and
  // let the move through; the household-wide guard still catches it.
  //
  // categories_household_name_key_unique now forbids that state outright, so it
  // is only reachable in a database predating migration 20260930000001 — drop
  // the index to build it. The guard is what turns such a row into a clean
  // `name_conflict` (a 409) instead of a raw SequelizeUniqueConstraintError on
  // save, which is its whole remaining job: catching a pre-existing
  // inconsistency, not a parent-local one.
  await allowDuplicateCategoryNames();
  const family = await Category.create({ householdId, name: 'Family', icon: null, parentId: null });
  await Category.create({ householdId, name: 'expenses', icon: null, parentId: family.id });
  await assert.rejects(
    () => reparentCategory(householdId, expenses.id, home.id),
    (e: unknown) => e instanceof CategoryError && e.code === 'name_conflict',
  );
});

test('rejects unknown node', async () => {
  await assert.rejects(
    () => reparentCategory(householdId, 999999, home.id),
    (e: unknown) => e instanceof CategoryError && e.code === 'not_found',
  );
});
