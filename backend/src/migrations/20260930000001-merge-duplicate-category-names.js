'use strict';

// Merge duplicate (household_id, name_key) categories, then replace the two
// partial unique indexes with one household-wide unique. The nightly
// enrichment job forked 15 categories in household 1 on 2026-09-29 because
// resolveCategoryPath looked names up parent-scoped; see
// docs/superpowers/specs/2026-09-30-cashflow-duplicate-categories-design.md.
//
// The winner/loser and budget decisions come from lib/categoryMergePlan.js, the
// same pure function src/categories/mergePlan.budgetInvariance.test.ts proves
// leaves every budget's spend unchanged.
//
// CONVERGENT, NOT TRANSACTIONAL: every step is derived from the CURRENT state by
// the planner, so a re-run after a partial failure recomputes a fresh plan and
// finishes the job (repoints find nothing left to move, an already-detached
// budget has a null category_id and is skipped, the index swap is guarded).
// That is what makes running this by hand safe.
const { planCategoryMerges } = require('../../lib/categoryMergePlan');

/** Every column that points at categories.id. */
const REFS = [
  ['transactions', 'final_category_id'],
  ['transactions', 'auto_category_id'],
  ['transactions', 'category_override_id'],
  ['rules', 'category_id'],
  ['budget_targets', 'category_id'],
  ['income_entries', 'category_id'],
  ['external_order_items', 'inferred_category_id'],
  ['external_order_items', 'category_override_id'],
];

module.exports = {
  async up(queryInterface) {
    const sql = queryInterface.sequelize;

    const [categories] = await sql.query(
      'SELECT id, household_id, parent_id, name, name_key FROM categories',
    );
    const rows = categories.map((c) => ({
      id: c.id, householdId: c.household_id, parentId: c.parent_id,
      name: c.name, nameKey: c.name_key,
    }));

    const refCounts = {};
    for (const [table, column] of REFS) {
      const [counts] = await sql.query(
        `SELECT ${column} AS id, COUNT(*) AS n FROM ${table} ` +
        `WHERE ${column} IS NOT NULL GROUP BY ${column}`,
      );
      for (const r of counts) refCounts[r.id] = (refCounts[r.id] || 0) + Number(r.n);
    }

    const [budgets] = await sql.query('SELECT id, category_id FROM budget_targets');
    const plan = planCategoryMerges(
      rows, refCounts, budgets.map((b) => ({ id: b.id, categoryId: b.category_id })),
    );

    // 1. Children first — categories_parent_id_fkey is ON DELETE RESTRICT.
    for (const r of plan.reparents) {
      await sql.query('UPDATE categories SET parent_id = :p WHERE id = :id', {
        replacements: { p: r.newParentId, id: r.childId },
      });
    }

    // 2. Repoint every non-budget reference, then delete the loser.
    for (const m of plan.merges) {
      for (const [table, column] of REFS) {
        if (table === 'budget_targets') continue; // decided per-row in step 3
        await sql.query(
          `UPDATE ${table} SET ${column} = :w WHERE ${column} = :l`,
          { replacements: { w: m.winnerId, l: m.loserId } },
        );
      }
    }

    // 3. Budget actions. Raw SQL on purpose: reconcileCategoryField nulls the
    //    `category` string whenever categoryId changes, and a detached row must
    //    keep its name — that string IS the exact-match the budget rolls up on.
    //
    //    Iterate plan.budgetActions DIRECTLY, never inside the per-loser loop
    //    above: Rule B applies to every anchored budget, so an action can name a
    //    budget whose anchor row SURVIVES (one sitting on a winner that adopts
    //    the loser's children). Such a budget has no FK behind it — a missed
    //    write raises nothing and the budget silently widens.
    for (const a of plan.budgetActions) {
      await sql.query('UPDATE budget_targets SET category_id = :c WHERE id = :id', {
        replacements: { c: a.categoryId, id: a.budgetId },
      });
    }

    // 4. Delete the losers, now that nothing references them.
    for (const m of plan.merges) {
      await sql.query('DELETE FROM categories WHERE id = :id', { replacements: { id: m.loserId } });
    }

    // 5. Guard before the unique index, mirroring 20260621000001 step 3.
    const [dupes] = await sql.query(
      'SELECT household_id, name_key, COUNT(*) AS c FROM categories ' +
        'GROUP BY household_id, name_key HAVING COUNT(*) > 1',
    );
    if (dupes.length > 0) {
      throw new Error(
        'category name_key collisions remain after the merge: ' + JSON.stringify(dupes),
      );
    }

    // 6. Swap the indexes. Guarded so a manual re-run is a no-op rather than an
    //    "index already exists" abort; sequelize-cli itself never re-runs a
    //    migration, but this one is the kind someone runs by hand while checking
    //    a merge, and a half-applied index swap is a bad place to land.
    const existing = (await queryInterface.showIndex('categories')).map((i) => i.name);
    if (!existing.includes('categories_household_name_key_unique')) {
      await queryInterface.addIndex('categories', ['household_id', 'name_key'], {
        name: 'categories_household_name_key_unique',
        unique: true,
      });
    }
    for (const stale of [
      'categories_household_parent_name_key_unique',
      'categories_household_root_name_key_unique',
    ]) {
      if (existing.includes(stale)) await queryInterface.removeIndex('categories', stale);
    }
  },

  async down(queryInterface, Sequelize) {
    // Restores the index shape from 20260621000001. The merged rows are NOT
    // restored — that data is gone and there is nothing to recreate it from.
    await queryInterface.addIndex('categories', ['household_id', 'parent_id', 'name_key'], {
      name: 'categories_household_parent_name_key_unique',
      unique: true,
      where: { parent_id: { [Sequelize.Op.ne]: null } },
    });
    await queryInterface.addIndex('categories', ['household_id', 'name_key'], {
      name: 'categories_household_root_name_key_unique',
      unique: true,
      where: { parent_id: null },
    });
    await queryInterface.removeIndex('categories', 'categories_household_name_key_unique');
  },
};
