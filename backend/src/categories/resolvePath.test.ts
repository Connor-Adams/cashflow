// backend/src/categories/resolvePath.test.ts
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { sequelize } from '../db';
import { Category, Household } from '../models';
import { resolveCategoryPath } from './resolvePath';

let householdId: number;

beforeEach(async () => {
  await sequelize.sync({ force: true });
  householdId = (await Household.create({ name: 'T' })).id;
});

test('creates the full chain and reports createdIds', async () => {
  const { leafId, createdIds } = await resolveCategoryPath(householdId, 'Work / Expenses / Internet');
  assert.equal(createdIds.length, 3);
  const leaf = await Category.findByPk(leafId);
  assert.equal(leaf?.name, 'Internet');
  const expenses = await Category.findByPk(leaf!.parentId!);
  assert.equal(expenses?.name, 'Expenses');
  const work = await Category.findByPk(expenses!.parentId!);
  assert.equal(work?.name, 'Work');
  assert.equal(work?.parentId, null);
});

test('resolving an existing chain creates nothing new', async () => {
  await resolveCategoryPath(householdId, 'Work / Expenses / Internet');
  const second = await resolveCategoryPath(householdId, 'Work / Expenses / Internet');
  assert.equal(second.createdIds.length, 0);
  assert.equal(await Category.count({ where: { householdId } }), 3);
});

test('matches existing siblings case-insensitively (no duplicate)', async () => {
  await resolveCategoryPath(householdId, 'Work / Internet');
  const again = await resolveCategoryPath(householdId, 'work / INTERNET');
  assert.equal(again.createdIds.length, 0);
  assert.equal(await Category.count({ where: { householdId } }), 2);
});

test('bare name resolves to a root node', async () => {
  const { leafId } = await resolveCategoryPath(householdId, 'Groceries');
  const node = await Category.findByPk(leafId);
  assert.equal(node?.parentId, null);
  assert.equal(node?.name, 'Groceries');
});

test('invalid path throws', async () => {
  await assert.rejects(() => resolveCategoryPath(householdId, 'Work//Internet'), /invalid category path/);
});
