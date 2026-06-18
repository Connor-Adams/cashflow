// backend/src/categories/reconcileCategoryField.test.ts
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { sequelize } from '../db';
import { Category, Household } from '../models';
import { reconcileCategoryField } from './reconcileCategoryField';

let householdId: number;
let root: number, child: number;
beforeEach(async () => {
  await sequelize.sync({ force: true });
  householdId = (await Household.create({ name: 'T' })).id;
  const work = await Category.create({ householdId, name: 'Work', icon: null, parentId: null });
  root = work.id;
  child = (await Category.create({ householdId, name: 'Internet', icon: null, parentId: work.id })).id;
});

// minimal fake instance implementing changed/get/set over a plain record
function fakeInstance(initial: Record<string, unknown>, dirty: Set<string>) {
  const data = { ...initial };
  return {
    data,
    changed: (f: string) => dirty.has(f),
    get: (f: string) => data[f],
    set: (f: string, v: unknown) => { data[f] = v; },
  };
}

test('id change is authoritative: derives the string from the node name', async () => {
  const inst = fakeInstance({ finalCategory: 'STALE', finalCategoryId: child }, new Set(['finalCategoryId']));
  await reconcileCategoryField({ instance: inst, householdId, strField: 'finalCategory', idField: 'finalCategoryId' });
  assert.equal(inst.data.finalCategory, 'Internet'); // derived from child node
  assert.equal(inst.data.finalCategoryId, child);    // id untouched
});

test('id set to null derives a null string', async () => {
  const inst = fakeInstance({ finalCategory: 'Internet', finalCategoryId: null }, new Set(['finalCategoryId']));
  await reconcileCategoryField({ instance: inst, householdId, strField: 'finalCategory', idField: 'finalCategoryId' });
  assert.equal(inst.data.finalCategory, null);
});

test('string change with no id change resolves to a ROOT id (legacy path)', async () => {
  const inst = fakeInstance({ finalCategory: 'Groceries', finalCategoryId: null }, new Set(['finalCategory']));
  await reconcileCategoryField({ instance: inst, householdId, strField: 'finalCategory', idField: 'finalCategoryId' });
  const node = await Category.findByPk(inst.data.finalCategoryId as number);
  assert.equal(node?.name, 'Groceries');
  assert.equal(node?.parentId, null); // root
});

test('both dirty → id wins (string overwritten from node name)', async () => {
  const inst = fakeInstance({ finalCategory: 'whatever', finalCategoryId: child }, new Set(['finalCategory', 'finalCategoryId']));
  await reconcileCategoryField({ instance: inst, householdId, strField: 'finalCategory', idField: 'finalCategoryId' });
  assert.equal(inst.data.finalCategory, 'Internet');
  assert.equal(inst.data.finalCategoryId, child);
});

test('nothing dirty → no-op', async () => {
  const inst = fakeInstance({ finalCategory: 'Internet', finalCategoryId: child }, new Set());
  await reconcileCategoryField({ instance: inst, householdId, strField: 'finalCategory', idField: 'finalCategoryId' });
  assert.equal(inst.data.finalCategory, 'Internet');
  assert.equal(inst.data.finalCategoryId, child);
});
