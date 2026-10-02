import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { Sequelize, DataTypes } from 'sequelize';
import { planCategoryMerges, type PlanCategory } from '../../categories/mergePlan';

let sequelize: Sequelize;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let migration: { up: (...a: any[]) => Promise<void>; down: (...a: any[]) => Promise<void> };

/** Only the columns 20260930000001 actually reads. */
async function buildSchema(qi: ReturnType<Sequelize['getQueryInterface']>) {
  await qi.createTable('categories', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    household_id: { type: DataTypes.INTEGER, allowNull: false },
    parent_id: { type: DataTypes.INTEGER, allowNull: true },
    name: { type: DataTypes.STRING(128), allowNull: false },
    name_key: { type: DataTypes.STRING(128), allowNull: false },
  });
  await qi.addIndex('categories', ['household_id', 'parent_id', 'name_key'], {
    name: 'categories_household_parent_name_key_unique',
    unique: true,
    where: { parent_id: { [Sequelize.Op.ne]: null } },
  });
  await qi.addIndex('categories', ['household_id', 'name_key'], {
    name: 'categories_household_root_name_key_unique',
    unique: true,
    where: { parent_id: null },
  });
  await qi.createTable('transactions', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    final_category_id: { type: DataTypes.INTEGER, allowNull: true },
    auto_category_id: { type: DataTypes.INTEGER, allowNull: true },
    category_override_id: { type: DataTypes.INTEGER, allowNull: true },
  });
  await qi.createTable('budget_targets', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    category: { type: DataTypes.STRING(128), allowNull: true },
    category_id: { type: DataTypes.INTEGER, allowNull: true },
    // `BudgetTarget` has `version: true` and `timestamps: true`; the migration
    // bumps both so a concurrent stale full-instance save fails its version
    // check instead of silently overwriting a detach.
    version: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    updated_at: { type: DataTypes.DATE, allowNull: true },
  });
  for (const table of ['rules', 'income_entries']) {
    await qi.createTable(table, {
      id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
      category_id: { type: DataTypes.INTEGER, allowNull: true },
    });
  }
  await qi.createTable('external_order_items', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    inferred_category_id: { type: DataTypes.INTEGER, allowNull: true },
    category_override_id: { type: DataTypes.INTEGER, allowNull: true },
  });
}

// The prod shape in miniature. Ids are explicit so the assertions can name them.
// 10 Subscriptions > 11 Ai, and a stray root 12 Ai        -> 11 wins (more refs)
// 20 Hobbies > 21 Golf > 22 Clublink, and a root 23 Golf  -> 21 wins, budget DETACHES
// 30 Household > 31 Groceries, and a root 32 Groceries    -> 31 wins, budget REPOINTS
// 40 Legacy (root, 0 refs) with child 41 Desk, and root 42 Legacy (2 refs) -> 42 wins, 41 moves
const CATS = [
  { id: 10, household_id: 1, parent_id: null, name: 'Subscriptions', name_key: 'subscriptions' },
  { id: 11, household_id: 1, parent_id: 10, name: 'Ai', name_key: 'ai' },
  { id: 12, household_id: 1, parent_id: null, name: 'Ai', name_key: 'ai' },
  { id: 20, household_id: 1, parent_id: null, name: 'Hobbies', name_key: 'hobbies' },
  { id: 21, household_id: 1, parent_id: 20, name: 'Golf', name_key: 'golf' },
  { id: 22, household_id: 1, parent_id: 21, name: 'Clublink', name_key: 'clublink' },
  { id: 23, household_id: 1, parent_id: null, name: 'Golf', name_key: 'golf' },
  { id: 30, household_id: 1, parent_id: null, name: 'Household', name_key: 'household' },
  { id: 31, household_id: 1, parent_id: 30, name: 'Groceries', name_key: 'groceries' },
  { id: 32, household_id: 1, parent_id: null, name: 'Groceries', name_key: 'groceries' },
  { id: 40, household_id: 1, parent_id: null, name: 'Legacy', name_key: 'legacy' },
  { id: 41, household_id: 1, parent_id: 40, name: 'Desk', name_key: 'desk' },
  { id: 42, household_id: 2, parent_id: null, name: 'Golf', name_key: 'golf' },
];

before(async () => {
  sequelize = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false });
  const qi = sequelize.getQueryInterface();
  await buildSchema(qi);
  await qi.bulkInsert('categories', CATS);
  // Ai: 5 refs on the nested 11, 1 on the stray root 12.
  await qi.bulkInsert('transactions', [
    ...Array.from({ length: 5 }, () => ({ final_category_id: 11 })),
    { final_category_id: 12, auto_category_id: 12, category_override_id: 12 },
    // Golf: nested 21 carries history, root 23 carries none.
    ...Array.from({ length: 4 }, () => ({ final_category_id: 21 })),
    // Groceries: nested 31 carries history.
    ...Array.from({ length: 3 }, () => ({ final_category_id: 31 })),
    // Legacy: root 40 has a child but no refs; there is no second Legacy in
    // household 1, so 40 is not part of any duplicate group. See the reparent
    // test, which adds one.
  ]);
  await qi.bulkInsert('rules', [{ category_id: 12 }]);
  // Seed the LOSER (12), not just the winner: repointing the winner is a no-op,
  // so a winner-only row leaves `income_entries` with ZERO discriminating
  // coverage (deleting its REFS entry still passed). It is the one reference
  // column with a real DB-level FK — `references: { model: 'categories' },
  // onDelete: 'SET NULL'` in 20260612000001-create-income-entries.js — so a
  // missed repoint does NOT raise on the loser DELETE; Postgres quietly NULLs
  // the category instead. The other seven columns were added without a
  // references clause.
  await qi.bulkInsert('income_entries', [{ category_id: 11 }, { category_id: 12 }]);
  await qi.bulkInsert('external_order_items', [{ inferred_category_id: 11, category_override_id: 12 }]);
  await qi.bulkInsert('budget_targets', [
    { id: 1, category: 'Golf', category_id: 23 },       // winner 21 has Clublink -> detach
    { id: 2, category: 'Groceries', category_id: 32 },  // winner 31 is childless -> repoint
    { id: 3, category: 'Clublink', category_id: 22 },   // untouched
  ]);
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  migration = require('../20260930000001-merge-duplicate-category-names.js');
  await migration.up(qi, Sequelize);
});

after(async () => { await sequelize.close(); });

async function rows<T>(q: string): Promise<T[]> {
  const [r] = await sequelize.query(q);
  return r as T[];
}

test('merges a nested duplicate into the reference-heavy node and repoints every column', async () => {
  assert.deepEqual(await rows("SELECT id FROM categories WHERE id = 12"), []);
  const counts = await rows<{ n: number }>(
    'SELECT COUNT(*) AS n FROM transactions WHERE final_category_id = 11',
  );
  assert.equal(counts[0].n, 6, 'the stray root’s transaction moved onto the nested node');
  assert.deepEqual(
    await rows<{ auto_category_id: number; category_override_id: number }>(
      'SELECT auto_category_id, category_override_id FROM transactions WHERE auto_category_id IS NOT NULL',
    ),
    [{ auto_category_id: 11, category_override_id: 11 }],
  );
  assert.deepEqual(await rows('SELECT category_id FROM rules'), [{ category_id: 11 }]);
  assert.deepEqual(
    await rows('SELECT category_id FROM income_entries ORDER BY id'),
    [{ category_id: 11 }, { category_id: 11 }],
    'income_entries.category_id is the only ref column with a real FK: an unrepointed ' +
      'row is SET NULL by the loser DELETE, losing the category silently',
  );
  assert.deepEqual(
    await rows('SELECT inferred_category_id, category_override_id FROM external_order_items'),
    [{ inferred_category_id: 11, category_override_id: 11 }],
  );
});

test('detaches a budget whose winner would widen what it counts', async () => {
  const [budget] = await rows<{
    category: string; category_id: number | null; version: number; updated_at: string | null;
  }>('SELECT category, category_id, version, updated_at FROM budget_targets WHERE id = 1');
  assert.equal(budget.category_id, null, 'winner 21 rolls up Clublink, so the id must be dropped');
  assert.equal(budget.category, 'Golf', 'the name string is the exact-match key and must survive');
  assert.equal(
    budget.version, 1,
    '`BudgetTarget` has `version: true`; the raw UPDATE must bump it so a concurrent stale ' +
      'full-instance save fails its version check instead of overwriting this detach — ' +
      '`budget_targets.category_id` has no FK, so it could write back a deleted id',
  );
  assert.notEqual(budget.updated_at, null, 'timestamps: true — the raw UPDATE must touch it too');
});

test('repoints a budget whose winner counts exactly the same names', async () => {
  const [budget] = await rows<{ category: string; category_id: number | null }>(
    'SELECT category, category_id FROM budget_targets WHERE id = 2',
  );
  assert.equal(budget.category_id, 31, 'both nodes are childless, so the name set is unchanged');
  assert.equal(budget.category, 'Groceries');
});

test('an untouched budget keeps version 0 — only the planned rows are written', async () => {
  const [budget] = await rows<{ version: number; updated_at: string | null }>(
    'SELECT version, updated_at FROM budget_targets WHERE id = 3',
  );
  assert.equal(budget.version, 0, 'Clublink is not in plan.budgetActions; nothing may touch it');
  assert.equal(budget.updated_at, null);
});

test('leaves a budget anchored on an untouched node exactly as it was', async () => {
  const [budget] = await rows<{ category: string; category_id: number | null }>(
    'SELECT category, category_id FROM budget_targets WHERE id = 3',
  );
  assert.equal(budget.category_id, 22, 'Clublink neither won nor lost nor gained a child');
  assert.equal(budget.category, 'Clublink');
});

/**
 * The only post-condition that catches a MISSED budget action.
 *
 * `plan.budgetActions` can hold a `detach` for a budget whose anchor row
 * SURVIVES (a budget on a winner that adopts the loser's children — Rule B
 * applies to every anchored budget, not only the ones pointing at a loser). For
 * that class there is no FK to violate, so skipping the write raises nothing and
 * the budget silently starts counting spend it never counted. Re-running the
 * planner over the written state is the check: if anything was left undone, the
 * planner still has something to say about it.
 */
test('the plan is exhausted: re-planning the written state yields an empty plan', async () => {
  const REFS: Array<[string, string]> = [
    ['transactions', 'final_category_id'],
    ['transactions', 'auto_category_id'],
    ['transactions', 'category_override_id'],
    ['rules', 'category_id'],
    ['budget_targets', 'category_id'],
    ['income_entries', 'category_id'],
    ['external_order_items', 'inferred_category_id'],
    ['external_order_items', 'category_override_id'],
  ];
  const cats: PlanCategory[] = (
    await rows<{
      id: number; household_id: number; parent_id: number | null; name: string; name_key: string;
    }>('SELECT id, household_id, parent_id, name, name_key FROM categories')
  ).map((c) => ({
    id: c.id, householdId: c.household_id, parentId: c.parent_id,
    name: c.name, nameKey: c.name_key,
  }));
  const refCounts: Record<number, number> = {};
  for (const [table, column] of REFS) {
    const counts = await rows<{ id: number; n: number }>(
      `SELECT ${column} AS id, COUNT(*) AS n FROM ${table} ` +
        `WHERE ${column} IS NOT NULL GROUP BY ${column}`,
    );
    for (const r of counts) refCounts[r.id] = (refCounts[r.id] ?? 0) + Number(r.n);
  }
  const budgets = (await rows<{ id: number; category_id: number | null }>(
    'SELECT id, category_id FROM budget_targets',
  )).map((b) => ({ id: b.id, categoryId: b.category_id }));

  assert.deepEqual(planCategoryMerges(cats, refCounts, budgets), {
    merges: [], reparents: [], budgetActions: [],
  }, 'the migration must leave nothing for the planner to do');
});

test('a household-2 category with the same name is untouched', async () => {
  const [row] = await rows<{ parent_id: number | null }>(
    'SELECT parent_id FROM categories WHERE id = 42',
  );
  assert.equal(row.parent_id, null, 'duplicate groups are scoped per household');
});

test('the global unique index exists and both partials are gone', async () => {
  const idx = await sequelize.getQueryInterface().showIndex('categories');
  const names = idx.map((i) => i.name);
  assert.ok(names.includes('categories_household_name_key_unique'));
  assert.ok(!names.includes('categories_household_parent_name_key_unique'));
  assert.ok(!names.includes('categories_household_root_name_key_unique'));
  await assert.rejects(
    () => sequelize.query(
      "INSERT INTO categories (household_id, parent_id, name, name_key) VALUES (1, 20, 'Groceries', 'groceries')",
    ),
    /UNIQUE|constraint/i,
    'a nested duplicate of an existing name must now be rejected',
  );
});

test('running up() again is a no-op and does not throw on the index swap', async () => {
  const before_ = await rows('SELECT id FROM categories ORDER BY id');
  await migration.up(sequelize.getQueryInterface(), Sequelize);
  assert.deepEqual(await rows('SELECT id FROM categories ORDER BY id'), before_);
});

test('moves a loser’s children onto the winner before deleting it', async () => {
  // A fresh DB: household 1 has root 40 Legacy (child 41 Desk, no refs) and
  // root 42 Legacy (2 refs). 42 wins by Rule W, so 41 must survive under 42 --
  // categories_parent_id_fkey is ON DELETE RESTRICT in the real schema.
  const db = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false });
  const qi = db.getQueryInterface();
  await buildSchema(qi);
  await qi.bulkInsert('categories', [
    { id: 40, household_id: 1, parent_id: null, name: 'Legacy', name_key: 'legacy' },
    { id: 41, household_id: 1, parent_id: 40, name: 'Desk', name_key: 'desk' },
  ]);
  // 42 must be nested to coexist with root 40 under the OLD partial indexes.
  await qi.bulkInsert('categories', [
    { id: 43, household_id: 1, parent_id: null, name: 'Archive', name_key: 'archive' },
    { id: 42, household_id: 1, parent_id: 43, name: 'Legacy', name_key: 'legacy' },
  ]);
  await qi.bulkInsert('transactions', [{ final_category_id: 42 }, { final_category_id: 42 }]);

  // The pre-flight refuses a plan with ANY reparent, and it runs before the
  // first write — see the "refuses" tests below. A caller that has reviewed the
  // move enumerates the exact pair; `sequelize-cli` passes only two arguments,
  // so production can never take this path.
  await assert.rejects(() => migration.up(qi, Sequelize), /refuses to run/);
  await migration.up(qi, Sequelize, { reviewedReparents: [[41, 42]] });

  const [r] = await db.query('SELECT id, parent_id FROM categories WHERE id IN (40, 41, 42) ORDER BY id');
  assert.deepEqual(r, [{ id: 41, parent_id: 42 }, { id: 42, parent_id: 43 }],
    'loser 40 is gone and its child now hangs off winner 42');
  await db.close();
});

test('down restores the two partial indexes and drops the household-wide one', async () => {
  const db = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false });
  const qi = db.getQueryInterface();
  await buildSchema(qi);
  await migration.up(qi, Sequelize);
  await migration.down(qi, Sequelize);
  const names = (await qi.showIndex('categories')).map((i) => i.name);
  assert.ok(names.includes('categories_household_parent_name_key_unique'));
  assert.ok(names.includes('categories_household_root_name_key_unique'));
  assert.ok(!names.includes('categories_household_name_key_unique'));
  // The restored shape must again permit the same name under two parents.
  await qi.bulkInsert('categories', [
    { id: 1, household_id: 1, parent_id: null, name: 'A', name_key: 'a' },
    { id: 2, household_id: 1, parent_id: null, name: 'B', name_key: 'b' },
    { id: 3, household_id: 1, parent_id: 1, name: 'Dup', name_key: 'dup' },
    { id: 4, household_id: 1, parent_id: 2, name: 'Dup', name_key: 'dup' },
  ]);
  await db.close();
});


/**
 * PRE-FLIGHT: a plan with any reparent must fail fast.
 *
 * `up()` has no wrapping transaction, and the header's convergence argument only
 * holds while `plan.reparents` is empty — step 1 is the one step a re-run cannot
 * redo correctly. Three concrete shapes, each of which used to corrupt or
 * bare-error instead of refusing. A fresh in-memory DB per shape, and each
 * asserts the tree is UNCHANGED: the pre-flight runs before the first write.
 */
async function freshDb() {
  const db = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false });
  await buildSchema(db.getQueryInterface());
  return db;
}

test('refuses a plain non-empty reparents plan, naming the pairs, before any write', async () => {
  const db = await freshDb();
  const qi = db.getQueryInterface();
  // root 1 'Dup' (loser, 0 refs) with child 2 'Kid'; nested 4 'Dup' (2 refs) wins.
  await qi.bulkInsert('categories', [
    { id: 1, household_id: 1, parent_id: null, name: 'Dup', name_key: 'dup' },
    { id: 2, household_id: 1, parent_id: 1, name: 'Kid', name_key: 'kid' },
    { id: 3, household_id: 1, parent_id: null, name: 'Other', name_key: 'other' },
    { id: 4, household_id: 1, parent_id: 3, name: 'Dup', name_key: 'dup' },
  ]);
  await qi.bulkInsert('transactions', [{ final_category_id: 4 }, { final_category_id: 4 }]);

  await assert.rejects(() => migration.up(qi, Sequelize), (e: Error) => {
    assert.match(e.message, /refuses to run/);
    assert.match(e.message, /childId 2 -> newParentId 4/, 'the message must name the pair');
    assert.match(e.message, /cycle/, 'and say why a raw-SQL reparent is unsafe');
    return true;
  });
  const [r] = await db.query('SELECT id, parent_id FROM categories ORDER BY id');
  assert.deepEqual(r, [
    { id: 1, parent_id: null }, { id: 2, parent_id: 1 },
    { id: 3, parent_id: null }, { id: 4, parent_id: 3 },
  ], 'nothing may be written: the pre-flight is step 0');
  await db.close();
});

test('refuses the grandchild shape that used to write a two-node parent cycle', async () => {
  const db = await freshDb();
  const qi = db.getQueryInterface();
  // L root 'Dup' (1) > C 'Mid' (2) > W 'Dup' (3). The winner is a GRANDCHILD of
  // its loser, so the planner emits `reparent 2 -> 3` while 3.parent_id is still
  // 2. `child.id !== winner.id` does not catch that, and because up() writes raw
  // SQL, src/categories/cycle.ts never runs: it used to finish with NO error,
  // leaving {2 -> 3, 3 -> 2} orphaned from every root. The step-5 duplicate guard
  // passes (each name_key appears once) and the unique index is created, so the
  // migration reported success on a corrupt tree.
  await qi.bulkInsert('categories', [
    { id: 1, household_id: 1, parent_id: null, name: 'Dup', name_key: 'dup' },
    { id: 2, household_id: 1, parent_id: 1, name: 'Mid', name_key: 'mid' },
    { id: 3, household_id: 1, parent_id: 2, name: 'Dup', name_key: 'dup' },
  ]);
  await qi.bulkInsert('transactions', [{ final_category_id: 3 }]);

  await assert.rejects(
    () => migration.up(qi, Sequelize),
    /refuses to run[\s\S]*childId 2 -> newParentId 3/,
  );
  const [r] = await db.query('SELECT id, parent_id FROM categories ORDER BY id');
  assert.deepEqual(r, [
    { id: 1, parent_id: null }, { id: 2, parent_id: 1 }, { id: 3, parent_id: 2 },
  ], 'no cycle written — the tree is exactly as it was');
  await db.close();
});

test('refuses the same-named-children collision instead of a bare unique-constraint error', async () => {
  const db = await freshDb();
  const qi = db.getQueryInterface();
  // The loser's child 'Kid' collides with an existing 'Kid' under the winner, so
  // the reparent used to abort mid-migration on the unique index with a bare
  // `SequelizeUniqueConstraintError | Validation error` and no diagnostics.
  await qi.bulkInsert('categories', [
    { id: 1, household_id: 1, parent_id: null, name: 'Dup', name_key: 'dup' },
    { id: 2, household_id: 1, parent_id: 1, name: 'Kid', name_key: 'kid' },
    { id: 3, household_id: 1, parent_id: null, name: 'Other', name_key: 'other' },
    { id: 4, household_id: 1, parent_id: 3, name: 'Dup', name_key: 'dup' },
    { id: 5, household_id: 1, parent_id: 4, name: 'Kid', name_key: 'kid' },
  ]);
  await qi.bulkInsert('transactions', [{ final_category_id: 4 }, { final_category_id: 4 }]);

  await assert.rejects(() => migration.up(qi, Sequelize), (e: Error) => {
    assert.match(e.message, /refuses to run/);
    assert.doesNotMatch(
      e.message, /SequelizeUniqueConstraintError|Validation error/,
      'the operator must get the reparent diagnosis, not a bare constraint error',
    );
    assert.match(e.message, /childId 2 -> newParentId 4/);
    return true;
  });
  const [r] = await db.query('SELECT id, parent_id FROM categories ORDER BY id');
  assert.deepEqual(r, [
    { id: 1, parent_id: null }, { id: 2, parent_id: 1 }, { id: 3, parent_id: null },
    { id: 4, parent_id: 3 }, { id: 5, parent_id: 4 },
  ]);
  await db.close();
});

test('the acknowledgement must match the computed plan exactly', async () => {
  const db = await freshDb();
  const qi = db.getQueryInterface();
  await qi.bulkInsert('categories', [
    { id: 1, household_id: 1, parent_id: null, name: 'Dup', name_key: 'dup' },
    { id: 2, household_id: 1, parent_id: 1, name: 'Kid', name_key: 'kid' },
    { id: 3, household_id: 1, parent_id: null, name: 'Other', name_key: 'other' },
    { id: 4, household_id: 1, parent_id: 3, name: 'Dup', name_key: 'dup' },
  ]);
  await qi.bulkInsert('transactions', [{ final_category_id: 4 }, { final_category_id: 4 }]);
  // A plan that DRIFTED away from the reviewed one must still refuse — the plan
  // is recomputed against live data, so it may not be the plan that was approved.
  await assert.rejects(
    () => migration.up(qi, Sequelize, { reviewedReparents: [[2, 99]] }), /refuses to run/,
  );
  await assert.rejects(
    () => migration.up(qi, Sequelize, { reviewedReparents: [[2, 4], [7, 8]] }), /refuses to run/,
  );
  await migration.up(qi, Sequelize, { reviewedReparents: [[2, 4]] });
  const [r] = await db.query('SELECT id, parent_id FROM categories ORDER BY id');
  assert.deepEqual(r, [{ id: 2, parent_id: 4 }, { id: 3, parent_id: null }, { id: 4, parent_id: 3 }]);
  await db.close();
});

test('refuses a pair spelled differently, because spend matches the string exactly', async () => {
  const db = await freshDb();
  const qi = db.getQueryInterface();
  // Only ids are repointed; `final_category = 'weed'` would stay, so a budget
  // repointed onto 'Weed' would stop counting it.
  await qi.bulkInsert('categories', [
    { id: 1, household_id: 1, parent_id: null, name: 'Weed', name_key: 'weed' },
    { id: 2, household_id: 1, parent_id: null, name: 'Other', name_key: 'other' },
    { id: 3, household_id: 1, parent_id: 2, name: 'weed', name_key: 'weed' },
  ]);
  await qi.bulkInsert('transactions', [{ final_category_id: 1 }, { final_category_id: 3 }]);
  await assert.rejects(() => migration.up(qi, Sequelize), (e: Error) => {
    assert.match(e.message, /differ in spelling/);
    assert.match(e.message, /loser 3 "weed" -> winner 1 "Weed"/);
    return true;
  });
  const [r] = await db.query('SELECT final_category_id FROM transactions ORDER BY id');
  assert.deepEqual(r, [{ final_category_id: 1 }, { final_category_id: 3 }]);
  await db.close();
});

/** A clean two-node duplicate: root 1 'Dup' (loser, 1 ref), nested 3 'Dup' (winner, 2 refs). */
async function seedSimpleDuplicate(qi: ReturnType<Sequelize['getQueryInterface']>) {
  await qi.bulkInsert('categories', [
    { id: 1, household_id: 1, parent_id: null, name: 'Dup', name_key: 'dup' },
    { id: 2, household_id: 1, parent_id: null, name: 'Other', name_key: 'other' },
    { id: 3, household_id: 1, parent_id: 2, name: 'Dup', name_key: 'dup' },
  ]);
  await qi.bulkInsert('transactions', [
    { final_category_id: 1 }, { final_category_id: 3 }, { final_category_id: 3 },
  ]);
}

test('a failure at any step rolls the whole merge back', async () => {
  const db = await freshDb();
  const qi = db.getQueryInterface();
  await seedSimpleDuplicate(qi);
  // Make the loser DELETE (step 4) fail AFTER the repoints (step 2) ran.
  await db.query(
    "CREATE TRIGGER no_delete BEFORE DELETE ON categories BEGIN SELECT RAISE(ABORT, 'boom'); END",
  );
  // Sequelize surfaces a SQLite RAISE(ABORT) as a generic 'Validation error'.
  await assert.rejects(() => migration.up(qi, Sequelize));
  const [r] = await db.query('SELECT final_category_id FROM transactions ORDER BY id');
  assert.deepEqual(
    r, [{ final_category_id: 1 }, { final_category_id: 3 }, { final_category_id: 3 }],
    'the step-2 repoint must be rolled back with the failed DELETE',
  );
  const idx = (await qi.showIndex('categories') as Array<{ name: string }>).map((i) => i.name);
  assert.ok(!idx.includes('categories_household_name_key_unique'));
  await db.close();
});

test('aborts before the DELETE if a loser reference appears after the repoint', async () => {
  const db = await freshDb();
  const qi = db.getQueryInterface();
  await seedSimpleDuplicate(qi);
  // Stand-in for a concurrent writer: once the repoint reaches the LAST REFS
  // table, write a fresh loser id into one already repointed. Postgres blocks
  // this with LOCK TABLE; the post-condition is the backstop either way.
  await qi.bulkInsert('external_order_items', [{ inferred_category_id: 1 }]);
  await qi.bulkInsert('transactions', [{ final_category_id: 3 }]); // keep 3 the winner
  await db.query(
    'CREATE TRIGGER late_writer AFTER UPDATE ON external_order_items ' +
      'BEGIN INSERT INTO transactions (final_category_id) VALUES (1); END',
  );
  await assert.rejects(
    () => migration.up(qi, Sequelize), /references to merged-away categories remain.*transactions\.final_category_id=1/,
  );
  const [cats] = await db.query('SELECT id FROM categories ORDER BY id');
  assert.deepEqual(cats, [{ id: 1 }, { id: 2 }, { id: 3 }], 'the loser must not be deleted');
  await db.close();
});
