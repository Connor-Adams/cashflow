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
// NOT TRANSACTIONAL, AND CONVERGENT ONLY WHILE THE PLAN HAS NO REPARENTS.
//
// Steps 2-6 are each derived from the CURRENT state by the planner, so a re-run
// after a partial failure recomputes a fresh plan and finishes the job (repoints
// find nothing left to move, an already-detached budget has a null category_id
// and is skipped, the index swap is guarded).
//
// Step 1 -- the reparents -- is NOT convergent, so the design above only holds
// for a plan whose `reparents` is empty:
//   * Rule B goes blind. Once a loser's child has been moved onto the winner,
//     the winner's `before` name set already contains that child, nothing
//     widens, and NO budget action is emitted for a budget anchored on the
//     winner. It stays anchored and silently starts counting the adopted
//     child's spend -- the exact widening Rule B exists to prevent. Re-planning
//     that state returns an EMPTY plan, so no post-condition catches it either.
//   * The planner can emit a cycle. Its only cycle guard is
//     `child.id !== winner.id`, which covers a direct parent/child pair. When
//     the winner is a GRANDCHILD of the loser the planner emits
//     `reparent C -> W` while `W.parent_id` is still `C`, and because these are
//     raw writes `src/categories/cycle.ts` never runs: up() finishes with no
//     error, leaving a two-node parent cycle orphaned from every root that the
//     step-5 duplicate guard happily passes.
//   * A loser's child whose name collides with an existing child of the winner
//     aborts on the unique index with a bare `SequelizeUniqueConstraintError`
//     carrying no diagnostic content.
//
// The PRE-FLIGHT in up() therefore refuses to run at all when the plan has any
// reparents. Production had 0 of them when this plan was approved; the plan is
// recomputed against LIVE data at run time, and this is the one path where
// drift corrupts silently instead of failing. Enforcing that precondition is
// what makes the no-transaction design safe to run by hand.
const { planCategoryMerges } = require('../../lib/categoryMergePlan');

/**
 * Refuse a plan that has to move a category, unless the caller has reviewed and
 * enumerated the exact `[childId, newParentId]` pairs.
 *
 * `options.reviewedReparents` is a TEST-ONLY acknowledgement hook: `sequelize-cli`
 * invokes `up(queryInterface, Sequelize)` with two arguments, so an operator can
 * never reach the acknowledged path -- for production this is a hard stop. The
 * pairs must match the computed plan EXACTLY (in both directions), so a plan that
 * drifted away from the reviewed one still fails rather than running.
 */
function assertReparentsReviewed(reparents, options) {
  if (reparents.length === 0) return;
  const key = (childId, newParentId) => `${childId}->${newParentId}`;
  const computed = Array.from(new Set(reparents.map((r) => key(r.childId, r.newParentId)))).sort();
  const reviewedInput = (options && options.reviewedReparents) || [];
  const reviewed = Array.from(
    new Set(reviewedInput.map((pair) => key(pair[0], pair[1]))),
  ).sort();
  if (computed.length === reviewed.length && computed.every((k, i) => k === reviewed[i])) return;
  throw new Error(
    '20260930000001 refuses to run: the plan computed against the CURRENT database ' +
    `contains ${reparents.length} category reparent(s) -- ` +
    reparents.map((r) => `(childId ${r.childId} -> newParentId ${r.newParentId})`).join(', ') +
    '. This migration has no wrapping transaction and is only convergent on re-run ' +
    'while the reparent list is empty: a re-run after a partial failure leaves a ' +
    'budget anchored on a winner that has already adopted the loser\'s children ' +
    'silently counting their spend, and a winner that is a grandchild of its loser ' +
    'yields a two-node parent cycle that up() writes without erroring. Production ' +
    'had 0 reparents when this plan was approved. Reconcile these parents by hand ' +
    '-- and re-check every budget anchored on the new parents -- before running ' +
    'the merge.',
  );
}

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
  async up(queryInterface, _Sequelize, options) {
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

    // 0. PRE-FLIGHT. Before ANY write: see the reparent discussion in the header.
    assertReparentsReviewed(plan.reparents, options);

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
    //
    //    `BudgetTarget` declares `version: true`, so a raw UPDATE that left
    //    `version` alone would let a concurrent app process holding a stale
    //    instance save straight over this detach with no version conflict — and
    //    since `budget_targets.category_id` has no DB-level FK, write back a
    //    now-deleted id. Bumping `version` (and `updated_at`, which the model's
    //    timestamps would otherwise have touched) makes that race fail loudly.
    for (const a of plan.budgetActions) {
      await sql.query(
        'UPDATE budget_targets SET category_id = :c, version = COALESCE(version, 0) + 1, ' +
          'updated_at = :now WHERE id = :id',
        { replacements: { c: a.categoryId, id: a.budgetId, now: new Date() } },
      );
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
