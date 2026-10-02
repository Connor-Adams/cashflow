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
// ONE TRANSACTION, WITH THE WRITERS LOCKED OUT.
//
// Everything after the reads runs in a single transaction, so a failure at any
// step rolls the whole merge back -- there is no partially-merged state to
// re-run from. On Postgres the transaction first takes SHARE ROW EXCLUSIVE on
// `categories` and every table in REFS: reads carry on, but no app process can
// write a loser's id between the repoint and the DELETE. That matters because
// migrations run at container start while the previous container may still be
// serving, six of the eight REFS columns have no DB-level FK (a late loser id
// would dangle silently), and `income_entries.category_id` is ON DELETE SET
// NULL (a late loser id would be nulled silently). A post-condition before the
// DELETE re-counts loser references and aborts if any remain.
//
// TWO PRE-FLIGHTS refuse a plan before any write.
//
// 1. Reparents. The planner can emit a reparent that this raw-SQL path cannot
//    apply safely:
//   * The planner can emit a cycle. Its only cycle guard is
//     `child.id !== winner.id`, which covers a direct parent/child pair. When
//     the winner is a GRANDCHILD of the loser the planner emits
//     `reparent C -> W` while `W.parent_id` is still `C`, and because these are
//     raw writes `src/categories/cycle.ts` never runs: up() would finish with no
//     error, leaving a two-node parent cycle orphaned from every root that the
//     step-5 duplicate guard happily passes.
//   * A loser's child whose name collides with an existing child of the winner
//     aborts on the unique index with a bare `SequelizeUniqueConstraintError`
//     carrying no diagnostic content.
//   * A budget anchored on a winner that adopts children is the one class of
//     budget write with no FK safety net behind it (see step 3).
//    Production had 0 reparents when this plan was approved; the plan is
//    recomputed against LIVE data at run time, so drift is refused, not run.
//
// 2. Spelling. Only the id columns are repointed; the string mirrors
//    (`transactions.final_category` etc.) keep the loser's spelling, and budget
//    spend matches those strings EXACTLY. A merge whose loser is spelled
//    differently from its winner ('weed' into 'Weed') would therefore shift a
//    repointed budget's spend. Production's 15 pairs are all exact-case, so the
//    migration refuses any pair that is not rather than rewriting strings.
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
    '. A reparent written by raw SQL bypasses src/categories/cycle.ts: a winner that ' +
    'is a grandchild of its loser yields a two-node parent cycle that up() writes ' +
    'without erroring, a child whose name collides with one under the winner aborts ' +
    'on a bare unique-constraint error, and a budget anchored on the adopting winner ' +
    'has no FK behind its detach. Production had 0 reparents when this plan was ' +
    'approved. Reconcile these parents by hand -- and re-check every budget anchored ' +
    'on the new parents -- before running the merge.',
  );
}

/**
 * Refuse a merge whose loser is spelled differently from its winner. Only id
 * columns are repointed and budget spend matches the string mirrors exactly, so
 * such a merge would silently shift what a repointed budget counts.
 */
function assertSameSpelling(merges, rows) {
  const nameById = new Map(rows.map((r) => [r.id, r.name]));
  const bad = merges.filter((m) => nameById.get(m.loserId) !== nameById.get(m.winnerId));
  if (bad.length === 0) return;
  throw new Error(
    '20260930000001 refuses to run: ' + bad.length + ' duplicate pair(s) differ in spelling -- ' +
    bad.map((m) => `(loser ${m.loserId} ${JSON.stringify(nameById.get(m.loserId))} -> ` +
      `winner ${m.winnerId} ${JSON.stringify(nameById.get(m.winnerId))})`).join(', ') +
    '. Only the id columns are repointed and budget spend matches the category STRING ' +
    'exactly, so merging these would shift budget spend. Rename one side to match the ' +
    'other first.',
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

const NEW_INDEX = 'categories_household_name_key_unique';
const STALE_INDEXES = [
  'categories_household_parent_name_key_unique',
  'categories_household_root_name_key_unique',
];

/**
 * Postgres only: lock `categories` and every REFS table against writes (reads
 * carry on), failing rather than hanging behind a long-running app transaction.
 */
async function lockWriters(q) {
  await q("SET LOCAL lock_timeout = '30s'");
  const tables = Array.from(new Set(['categories', ...REFS.map(([t]) => t)]));
  await q(`LOCK TABLE ${tables.join(', ')} IN SHARE ROW EXCLUSIVE MODE`);
}

/** Read the current state and compute the plan from it. */
async function computePlan(q) {
  const [categories] = await q('SELECT id, household_id, parent_id, name, name_key FROM categories');
  const rows = categories.map((c) => ({
    id: c.id, householdId: c.household_id, parentId: c.parent_id, name: c.name, nameKey: c.name_key,
  }));

  const refCounts = {};
  for (const [table, column] of REFS) {
    const [counts] = await q(
      `SELECT ${column} AS id, COUNT(*) AS n FROM ${table} WHERE ${column} IS NOT NULL GROUP BY ${column}`,
    );
    for (const r of counts) refCounts[r.id] = (refCounts[r.id] || 0) + Number(r.n);
  }

  const [budgets] = await q('SELECT id, category_id FROM budget_targets');
  const plan = planCategoryMerges(
    rows, refCounts, budgets.map((b) => ({ id: b.id, categoryId: b.category_id })),
  );
  return { rows, plan };
}

/** Step 2: repoint every non-budget reference from each loser to its winner. */
async function repointReferences(q, merges) {
  for (const m of merges) {
    for (const [table, column] of REFS) {
      if (table === 'budget_targets') continue; // decided per-row in step 3
      await q(`UPDATE ${table} SET ${column} = :w WHERE ${column} = :l`, {
        w: m.winnerId, l: m.loserId,
      });
    }
  }
}

/**
 * Step 3: budget actions. Raw SQL on purpose: reconcileCategoryField nulls the
 * `category` string whenever categoryId changes, and a detached row must keep
 * its name — that string IS the exact-match the budget rolls up on.
 *
 * Iterate plan.budgetActions DIRECTLY, never inside the per-loser loop: Rule B
 * applies to every anchored budget, so an action can name a budget whose anchor
 * row SURVIVES (one sitting on a winner that adopts the loser's children). Such
 * a budget has no FK behind it — a missed write raises nothing and the budget
 * silently widens.
 *
 * `BudgetTarget` declares `version: true`, so a raw UPDATE that left `version`
 * alone would let a concurrent app process holding a stale instance save
 * straight over this detach with no version conflict — and since
 * `budget_targets.category_id` has no DB-level FK, write back a now-deleted id.
 * Bumping `version` (and `updated_at`, which the model's timestamps would
 * otherwise have touched) makes that race fail loudly.
 */
async function applyBudgetActions(q, budgetActions) {
  for (const a of budgetActions) {
    await q(
      'UPDATE budget_targets SET category_id = :c, version = COALESCE(version, 0) + 1, ' +
        'updated_at = :now WHERE id = :id',
      { c: a.categoryId, id: a.budgetId, now: new Date() },
    );
  }
}

/**
 * Step 4 post-condition: nothing may still point at a loser. Six REFS columns
 * have no FK (the DELETE would leave a dangling id) and income_entries is
 * ON DELETE SET NULL (it would be nulled).
 */
async function assertNoLoserReferences(q, loserIds) {
  if (loserIds.length === 0) return;
  const remaining = [];
  for (const [table, column] of REFS) {
    const [[r]] = await q(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} IN (:ids)`, {
      ids: loserIds,
    });
    if (Number(r.n) > 0) remaining.push(`${table}.${column}=${Number(r.n)}`);
  }
  if (remaining.length > 0) {
    throw new Error(
      'references to merged-away categories remain after the repoint: ' + remaining.join(', '),
    );
  }
}

/** Step 5: guard before the unique index, mirroring 20260621000001 step 3. */
async function assertNoDuplicateNames(q) {
  const [dupes] = await q(
    'SELECT household_id, name_key, COUNT(*) AS c FROM categories ' +
      'GROUP BY household_id, name_key HAVING COUNT(*) > 1',
  );
  if (dupes.length > 0) {
    throw new Error('category name_key collisions remain after the merge: ' + JSON.stringify(dupes));
  }
}

/**
 * Step 6: swap the indexes. Guarded so a manual re-run is a no-op rather than
 * an "index already exists" abort.
 */
async function swapIndexes(queryInterface, transaction) {
  const existing = (await queryInterface.showIndex('categories', { transaction })).map((i) => i.name);
  if (!existing.includes(NEW_INDEX)) {
    await queryInterface.addIndex('categories', ['household_id', 'name_key'], {
      name: NEW_INDEX, unique: true, transaction,
    });
  }
  for (const stale of STALE_INDEXES.filter((name) => existing.includes(name))) {
    await queryInterface.removeIndex('categories', stale, { transaction });
  }
}

module.exports = {
  async up(queryInterface, _Sequelize, options) {
    const sql = queryInterface.sequelize;
    const isPostgres = sql.getDialect() === 'postgres';

    await sql.transaction(async (transaction) => {
      const q = (text, replacements) => sql.query(text, { replacements, transaction });
      if (isPostgres) await lockWriters(q);

      const { rows, plan } = await computePlan(q);

      // 0. PRE-FLIGHTS. Before ANY write: see the header.
      assertReparentsReviewed(plan.reparents, options);
      assertSameSpelling(plan.merges, rows);

      // The merge deletes rows irreversibly; leave a record of what it decided.
      console.log('[20260930000001] merge plan ' + JSON.stringify({
        merges: plan.merges.map((m) => ({ winnerId: m.winnerId, loserId: m.loserId, nameKey: m.nameKey })),
        reparents: plan.reparents,
        budgetActions: plan.budgetActions,
      }));

      // 1. Children first — categories_parent_id_fkey is ON DELETE RESTRICT.
      for (const r of plan.reparents) {
        await q('UPDATE categories SET parent_id = :p WHERE id = :id', { p: r.newParentId, id: r.childId });
      }
      await repointReferences(q, plan.merges);
      await applyBudgetActions(q, plan.budgetActions);

      // 4. Post-condition, then delete the losers.
      const loserIds = plan.merges.map((m) => m.loserId);
      await assertNoLoserReferences(q, loserIds);
      for (const id of loserIds) {
        await q('DELETE FROM categories WHERE id = :id', { id });
      }

      await assertNoDuplicateNames(q);
      await swapIndexes(queryInterface, transaction);
    });
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
