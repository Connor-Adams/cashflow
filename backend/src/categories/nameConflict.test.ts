// backend/src/categories/nameConflict.test.ts
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { sequelize } from '../db';
import { Category, Household } from '../models';
import { findCategoryNameConflict } from './nameConflict';
import { normalizeCategoryName } from './normalizeName';

let householdId: number;
let otherHouseholdId: number;

beforeEach(async () => {
  await sequelize.sync({ force: true });
  householdId = (await Household.create({ name: 'H1' })).id;
  otherHouseholdId = (await Household.create({ name: 'H2' })).id;
});

test('finds a conflict anywhere in the household, not just under the same parent', async () => {
  // This is the exact shape the PATCH /api/categories/:id rename handler
  // hits: renaming a node under "work" to a name that already exists under a
  // third, unrelated branch ("family"). A parent-scoped lookup
  // (`where: { parentId: node.parentId, ... }`) would find nothing here and
  // let the rename through — that's the widening Task 5 made, and the only
  // thing this test exists to pin.
  const work = await Category.create({ householdId, name: 'Work', icon: null, parentId: null });
  const family = await Category.create({ householdId, name: 'Family', icon: null, parentId: null });
  const internet = await Category.create({ householdId, name: 'Internet', icon: null, parentId: work.id });
  await Category.create({ householdId, name: 'Mobile', icon: null, parentId: family.id });

  const conflict = await findCategoryNameConflict(
    householdId,
    normalizeCategoryName('Mobile'),
    internet.id,
  );
  assert.notEqual(conflict, null);
  assert.equal(conflict?.name, 'Mobile');
});

test('still catches an ordinary sibling conflict', async () => {
  const work = await Category.create({ householdId, name: 'Work', icon: null, parentId: null });
  const internet = await Category.create({ householdId, name: 'Internet', icon: null, parentId: work.id });
  await Category.create({ householdId, name: 'Phone', icon: null, parentId: work.id });

  const conflict = await findCategoryNameConflict(
    householdId,
    normalizeCategoryName('Phone'),
    internet.id,
  );
  assert.notEqual(conflict, null);
});

test('excludes the row itself (renaming to its own current name is not a conflict)', async () => {
  const internet = await Category.create({ householdId, name: 'Internet', icon: null, parentId: null });

  const conflict = await findCategoryNameConflict(
    householdId,
    normalizeCategoryName('Internet'),
    internet.id,
  );
  assert.equal(conflict, null);
});

test('does not cross household boundaries', async () => {
  await Category.create({ householdId: otherHouseholdId, name: 'Golf', icon: null, parentId: null });
  const conflict = await findCategoryNameConflict(householdId, normalizeCategoryName('Golf'));
  assert.equal(conflict, null);
});
