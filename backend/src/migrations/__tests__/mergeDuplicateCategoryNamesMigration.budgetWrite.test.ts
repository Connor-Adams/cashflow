/**
 * The hard gate: 20260930000001 must write `budget_targets` with RAW SQL.
 *
 * `BudgetTarget` installs a `beforeSave` hook that calls
 * `reconcileCategoryField`, which NULLS the `category` STRING whenever
 * `categoryId` changes. `computeBudgetProgress` in `src/routes/budgets.ts` prices
 * a budget whose `category` is null as the ENTIRE currency's spend total, so a
 * model-mediated detach would turn a $0 budget into whole-currency spend. The
 * `category` string is the exact-match key a detached budget rolls up on — it
 * must survive.
 *
 * The in-memory sibling test (`mergeDuplicateCategoryNamesMigration.test.ts`)
 * cannot catch this: it builds stub tables with `queryInterface.createTable`, so
 * no model — and therefore no hook — is bound to that connection. This file runs
 * the same migration against the REAL model-backed schema on the shared unit-test
 * database, so swapping the raw `UPDATE` for `instance.save()` fails here.
 */
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { Sequelize } from 'sequelize';
import { sequelize } from '../../db';
import { BudgetTarget, Category, Household } from '../../models';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let migration: { up: (...a: any[]) => Promise<void> };
let householdId: number;
let hobbiesId: number, nestedGolfId: number, strayGolfId: number, clublinkId: number;
let budgetId: number;

before(async () => {
  await sequelize.sync({ force: true });
  const qi = sequelize.getQueryInterface();
  // The model now declares one household-wide unique index, which is exactly
  // what makes the duplicate pair below unrepresentable. Drop it to rebuild the
  // pre-merge production shape; the migration adds it back in its final step.
  const names = (await qi.showIndex('categories')).map((i) => i.name);
  if (names.includes('categories_household_name_key_unique')) {
    await qi.removeIndex('categories', 'categories_household_name_key_unique');
  }

  householdId = (await Household.create({ name: 'Gate' })).id;
  // Hobbies > Golf  (the WINNER: it carries the budget's one reference)
  // Golf (stray root, 0 references) > Clublink  (the LOSER, with a child)
  // So the winner adopts `Clublink` and the budget anchored on the winner —
  // whose row SURVIVES — must still detach. That is the class of budget action
  // with no FK safety net behind it.
  hobbiesId = (await Category.create({
    householdId, name: 'Hobbies', parentId: null, icon: null,
  })).id;
  nestedGolfId = (await Category.create({
    householdId, name: 'Golf', parentId: hobbiesId, icon: null,
  })).id;
  strayGolfId = (await Category.create({
    householdId, name: 'Golf', parentId: null, icon: null,
  })).id;
  clublinkId = (await Category.create({
    householdId, name: 'Clublink', parentId: strayGolfId, icon: null,
  })).id;

  budgetId = (await BudgetTarget.create({
    householdId, category: 'Golf', categoryId: nestedGolfId,
    currency: 'CAD', amount: '50.0000',
  })).id;

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  migration = require('../20260930000001-merge-duplicate-category-names.js');
  await migration.up(qi, Sequelize);
});

/** Read the row as the database holds it: no model, no getters, no hooks. */
async function budgetRow() {
  const [r] = await sequelize.query(
    'SELECT category, category_id FROM budget_targets WHERE id = :id',
    { replacements: { id: budgetId } },
  );
  return (r as Array<{ category: string | null; category_id: number | null }>)[0];
}

test('the detached budget keeps its `category` string — the hook must never run', async () => {
  const row = await budgetRow();
  assert.equal(row.category_id, null, 'Rule B detaches: the winner adopted Clublink');
  assert.equal(
    row.category, 'Golf',
    'reconcileCategoryField nulls `category` on an id change; a null `category` prices as ' +
    'the whole currency total in computeBudgetProgress. The migration must use raw SQL.',
  );
});

test('the merge itself landed: loser deleted, its child moved onto the winner', async () => {
  const [cats] = await sequelize.query(
    'SELECT id, parent_id FROM categories WHERE household_id = :h ORDER BY id',
    { replacements: { h: householdId } },
  );
  assert.deepEqual(cats, [
    { id: hobbiesId, parent_id: null },
    { id: nestedGolfId, parent_id: hobbiesId },
    { id: clublinkId, parent_id: nestedGolfId },
  ], 'the stray root Golf is gone and Clublink now hangs off the nested Golf');
  assert.ok(!(cats as Array<{ id: number }>).some((c) => c.id === strayGolfId));
});

test('the household-wide unique index is in place on the real schema', async () => {
  const names = (await sequelize.getQueryInterface().showIndex('categories')).map((i) => i.name);
  assert.ok(names.includes('categories_household_name_key_unique'));
  await assert.rejects(
    () => Category.create({ householdId, name: 'Clublink', parentId: hobbiesId, icon: null }),
    /UNIQUE|constraint|conflict/i,
    'a second Clublink under a different parent must now be rejected',
  );
});
