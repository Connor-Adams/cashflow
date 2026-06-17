// backend/src/categories/rollup.test.ts
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { sequelize } from '../db';
import { Category, Household } from '../models';
import { loadCategoryTree, rollupByCategoryId, buildRollupRows } from './rollup';

let householdId: number;
let work: number, expenses: number, internet: number;
beforeEach(async () => {
  await sequelize.sync({ force: true });
  householdId = (await Household.create({ name: 'T' })).id;
  work = (await Category.create({ householdId, name: 'Work', icon: null, parentId: null })).id;
  expenses = (await Category.create({ householdId, name: 'Expenses', icon: null, parentId: work })).id;
  internet = (await Category.create({ householdId, name: 'Internet', icon: null, parentId: expenses })).id;
});

test('loadCategoryTree builds parent/name/depth/path maps', async () => {
  const tree = await loadCategoryTree(householdId);
  assert.equal(tree.parentById.get(internet), expenses);
  assert.equal(tree.parentById.get(work), null);
  assert.equal(tree.nameById.get(internet), 'Internet');
  assert.equal(tree.depthById.get(work), 0);
  assert.equal(tree.depthById.get(internet), 2);
  assert.equal(tree.pathById.get(internet), 'Work / Expenses / Internet');
});

test('rollupByCategoryId folds descendants into ancestors (no double count)', async () => {
  const tree = await loadCategoryTree(householdId);
  // parent directly tagged $50, child $20, grandchild $30
  const raw = new Map<number, number>([[work, 50], [expenses, 20], [internet, 30]]);
  const rolled = rollupByCategoryId(raw, tree);
  assert.equal(rolled.get(internet), 30);
  assert.equal(rolled.get(expenses), 50);  // 20 + 30
  assert.equal(rolled.get(work), 100);      // 50 + 20 + 30
});

test('buildRollupRows returns sorted rows with direct + rolled totals', async () => {
  const tree = await loadCategoryTree(householdId);
  const raw = new Map<number, number>([[work, 50], [internet, 30]]);
  const rows = buildRollupRows(raw, tree);
  const byId = new Map(rows.map((r) => [r.categoryId, r]));
  assert.equal(byId.get(work)!.directTotal, 50);
  assert.equal(byId.get(work)!.rolledTotal, 80);
  assert.equal(byId.get(internet)!.directTotal, 30);
  assert.equal(byId.get(internet)!.rolledTotal, 30);
  assert.equal(byId.get(internet)!.path, 'Work / Expenses / Internet');
  // expenses has no direct spend but is an ancestor of internet → appears with rolled 30
  assert.equal(byId.get(expenses)!.directTotal, 0);
  assert.equal(byId.get(expenses)!.rolledTotal, 30);
});

test('rollup ignores ids not in the tree (stale/cross-household) without throwing', async () => {
  const tree = await loadCategoryTree(householdId);
  const rolled = rollupByCategoryId(new Map([[999999, 10]]), tree);
  assert.equal(rolled.get(999999), undefined);
});
