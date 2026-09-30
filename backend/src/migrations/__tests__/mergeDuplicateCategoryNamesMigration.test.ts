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
  await qi.bulkInsert('income_entries', [{ category_id: 11 }]);
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
    await rows('SELECT inferred_category_id, category_override_id FROM external_order_items'),
    [{ inferred_category_id: 11, category_override_id: 11 }],
  );
});

test('detaches a budget whose winner would widen what it counts', async () => {
  const [budget] = await rows<{ category: string; category_id: number | null }>(
    'SELECT category, category_id FROM budget_targets WHERE id = 1',
  );
  assert.equal(budget.category_id, null, 'winner 21 rolls up Clublink, so the id must be dropped');
  assert.equal(budget.category, 'Golf', 'the name string is the exact-match key and must survive');
});

test('repoints a budget whose winner counts exactly the same names', async () => {
  const [budget] = await rows<{ category: string; category_id: number | null }>(
    'SELECT category, category_id FROM budget_targets WHERE id = 2',
  );
  assert.equal(budget.category_id, 31, 'both nodes are childless, so the name set is unchanged');
  assert.equal(budget.category, 'Groceries');
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
  await migration.up(qi, Sequelize);

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
