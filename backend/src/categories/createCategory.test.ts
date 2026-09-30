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

test('rejects a duplicate sibling name case-insensitively (name_conflict)', async () => {
  const parent = await Category.create({ householdId, name: 'Work', icon: null, parentId: null });
  await createCategory(householdId, 'Internet', parent.id);
  await assert.rejects(
    () => createCategory(householdId, 'INTERNET', parent.id),
    (e: unknown) => e instanceof CategoryError && e.code === 'name_conflict',
  );
});

test('rejects a name containing "/" — the path separator (invalid_name)', async () => {
  await assert.rejects(
    () => createCategory(householdId, 'Household / Vape', null),
    (e: unknown) => e instanceof CategoryError && e.code === 'invalid_name',
  );
});

test('the model itself refuses to persist a name containing "/" (last-resort invariant)', async () => {
  await assert.rejects(
    () => Category.create({ householdId, name: 'Household / Vape', parentId: null, icon: null }),
    (e: unknown) => e instanceof CategoryError && e.code === 'invalid_name',
  );
});

test('rejects the same name under two different parents (household-wide uniqueness)', async () => {
  // This used to be legal ("allows the same name under two different
  // parents") when the conflict check was scoped to parentId. That's exactly
  // the behavior Task 5 removes: names are unique per household now, not per
  // parent, so this must reject even though the two "Internet"s would have
  // different parents.
  const work = await Category.create({ householdId, name: 'Work', icon: null, parentId: null });
  const home = await Category.create({ householdId, name: 'Home', icon: null, parentId: null });
  await createCategory(householdId, 'Internet', work.id);
  await assert.rejects(
    () => createCategory(householdId, 'Internet', home.id),
    (e: unknown) => e instanceof CategoryError && e.code === 'name_conflict',
  );
});

test('rejects a name that exists anywhere in the household, not just as a sibling', async () => {
  const subs = await Category.create({ householdId, name: 'Subscriptions', parentId: null });
  await Category.create({ householdId, name: 'Ai', parentId: subs.id });
  await assert.rejects(
    () => createCategory(householdId, 'Ai', null),
    (e: CategoryError) => e.code === 'name_conflict',
  );
});

test('rejects a nested name that collides with an existing root', async () => {
  const house = await Category.create({ householdId, name: 'Household', parentId: null });
  await Category.create({ householdId, name: 'Office Equipment', parentId: null });
  await assert.rejects(
    () => createCategory(householdId, 'Office Equipment', house.id),
    (e: CategoryError) => e.code === 'name_conflict',
  );
});

test('the same name in a different household is still fine', async () => {
  const other = (await Household.create({ name: 'Other' })).id;
  await Category.create({ householdId, name: 'Golf', parentId: null });
  const row = await createCategory(other, 'Golf', null);
  assert.equal(row.name, 'Golf');
});
