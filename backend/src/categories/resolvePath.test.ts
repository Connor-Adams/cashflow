// backend/src/categories/resolvePath.test.ts
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { sequelize } from '../db';
import { Category, Household } from '../models';
import { resolveCategoryPath } from './resolvePath';
import { allowDuplicateCategoryNames } from './duplicateNameFixture.testHelper';

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

test('name_key normalization folds case, so a differently-cased path creates nothing', async () => {
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

test('a bare name reuses a nested node instead of forking a root', async () => {
  // The exact prod shape: Subscriptions / Ai exists, and the AI returns "Ai".
  const subs = await Category.create({ householdId, name: 'Subscriptions', parentId: null });
  const ai = await Category.create({ householdId, name: 'Ai', parentId: subs.id });
  const { leafId, createdIds } = await resolveCategoryPath(householdId, 'Ai');
  assert.equal(leafId, ai.id);
  assert.equal(createdIds.length, 0);
  assert.equal(await Category.count({ where: { householdId } }), 2);
});

test('a path whose leaf lives under a different parent reuses it, and does not reparent it', async () => {
  const house = await Category.create({ householdId, name: 'Household', parentId: null });
  const groceries = await Category.create({ householdId, name: 'Groceries', parentId: house.id });
  const { leafId, createdIds } = await resolveCategoryPath(householdId, 'Food / Groceries');
  assert.equal(leafId, groceries.id);
  const food = await Category.findOne({ where: { householdId, nameKey: 'food' } });
  assert.deepEqual(createdIds, [food!.id], 'only the missing "Food" segment is created');
  await groceries.reload();
  assert.equal(groceries.parentId, house.id, 'the hint must not move an existing node');
});

test('a name absent from the household is still created at the walk position', async () => {
  const { leafId, createdIds } = await resolveCategoryPath(householdId, 'Work / Internet');
  assert.equal(createdIds.length, 2);
  const leaf = await Category.findByPk(leafId);
  assert.equal(leaf?.name, 'Internet');
  assert.equal((await Category.findByPk(leaf!.parentId!))?.name, 'Work');
});

test('the name lookup emits ORDER BY id, so duplicates resolve deterministically', async () => {
  // Asserting the RESULT is vacuous: SQLite's natural scan order already returns
  // the lower rowid, so a fixture-based test passes with or without the `order`
  // clause in resolvePath.ts. The determinism guarantee lives in the SQL, and
  // only Postgres (no heap order) can actually violate it — so assert the clause
  // is emitted, the way the SAVEPOINT test below does.
  const sql: string[] = [];
  const original = sequelize.options.logging;
  sequelize.options.logging = (line: string) => {
    sql.push(line);
  };
  try {
    await resolveCategoryPath(householdId, 'Subscriptions / Ai');
  } finally {
    sequelize.options.logging = original;
  }
  // The by-name lookup is the only SELECT that filters on name_key.
  const lookups = sql.filter((line) => /SELECT/.test(line) && /name_key/.test(line));
  assert.ok(lookups.length > 0, `no name_key lookup was logged, got: ${sql.join(' | ')}`);
  const orderedById = /ORDER BY\s+[`"[]?Category[`"\]]?\.[`"[]?id[`"\]]?\s+ASC/;
  for (const lookup of lookups) {
    assert.match(lookup, orderedById);
  }
});

test('duplicate names resolve to the LOWEST (oldest) id', async () => {
  // The prod shape migration 20260930000001 cleaned up: the two partial indexes
  // let a root "Ai" coexist with a nested "Subscriptions / Ai". An unordered
  // LIMIT 1 would return whichever row the planner handed back; the resolver must
  // always pick the oldest, matching the merge planner's lowest-id tie-break.
  // categories_household_name_key_unique forbids the shape now, so it survives
  // only in a database predating that migration — drop the index to build it.
  await allowDuplicateCategoryNames();
  const subs = await Category.create({ householdId, name: 'Subscriptions', parentId: null });
  const nested = await Category.create({ householdId, name: 'Ai', parentId: subs.id });
  const duplicateRoot = await Category.create({ householdId, name: 'Ai', parentId: null });
  assert.ok(nested.id < duplicateRoot.id, 'fixture: the nested node is the older of the pair');

  const { leafId, createdIds } = await resolveCategoryPath(householdId, 'Ai');
  assert.equal(leafId, Math.min(nested.id, duplicateRoot.id));
  assert.equal(leafId, nested.id);
  assert.equal(createdIds.length, 0);

  // SQLite-harness teardown, not a production concern. `PRAGMA FOREIGN_KEYS=ON`
  // is set per connection, and SQLite runs an implicit `DELETE FROM` before a
  // `DROP TABLE` — so the next `sync({ force: true })` deletes "Subscriptions",
  // the belongsTo's default ON DELETE SET NULL promotes nested "Ai" to a root,
  // and it collides with this duplicate root. The DROP then fails with
  // "UNIQUE constraint failed: categories.household_id, categories.name_key"
  // and breaks the NEXT test's beforeEach. `allowDuplicateCategoryNames()` above
  // already removes the index this would violate; drop the childless duplicate
  // anyway so the leftover shape is one the drop can unwind either way.
  await duplicateRoot.destroy();
});

test('"Food / Food" truncates to the Food node and does not throw', async () => {
  // The UI hands the user this exact string: flattenTreeToPaths emits every
  // node's full root-to-node path, and a child named "Food" under a root named
  // "Food" was legal before migration 20260930000001 made names unique per
  // household. Such a tree still exists in any database not yet migrated, and a
  // 400 here would reject a value the server's own tree offered.
  const { leafId, createdIds } = await resolveCategoryPath(householdId, 'Food / Food');
  const food = await Category.findOne({ where: { householdId, nameKey: 'food' } });
  assert.equal(leafId, food!.id);
  assert.deepEqual(createdIds, [food!.id], 'only the single "Food" node is created');
  assert.equal(await Category.count({ where: { householdId } }), 1);

  // Second call resolves to the same node and creates nothing.
  const again = await resolveCategoryPath(householdId, 'Food / Food');
  assert.equal(again.leafId, food!.id);
  assert.deepEqual(again.createdIds, []);
  assert.equal(await Category.count({ where: { householdId } }), 1);
});

test('the real UI shape — a child sharing its parent\'s name — resolves to the existing root', async () => {
  // flattenTreeToPaths turns this tree into the string "Food / Food". Names are
  // unique per household now (migration 20260930000001), so the tree only exists
  // in a database predating it — drop the index to reproduce it.
  await allowDuplicateCategoryNames();
  const root = await Category.create({ householdId, name: 'Food', parentId: null });
  await Category.create({ householdId, name: 'Food', parentId: root.id });
  const { leafId, createdIds } = await resolveCategoryPath(householdId, 'Food / Food');
  assert.equal(leafId, root.id, 'resolves household-globally to the oldest "Food"');
  assert.deepEqual(createdIds, [], 'creates nothing');
  assert.equal(await Category.count({ where: { householdId } }), 2);
});

test('"Food / Bar / Food" truncates to Food / Bar, creating no unreachable node', async () => {
  // Before the truncation this returned { leafId: <root Food>, createdIds: [<Bar>] }:
  // a leaf that is an ANCESTOR of the node the same call created, leaving "Bar"
  // dangling and empty. Nothing is created after the truncation point now, so
  // the orphan is impossible by construction.
  const { leafId, createdIds } = await resolveCategoryPath(householdId, 'Food / Bar / Food');
  const food = await Category.findOne({ where: { householdId, nameKey: 'food' } });
  const bar = await Category.findOne({ where: { householdId, nameKey: 'bar' } });
  assert.equal(leafId, bar!.id, 'the leaf is Bar, not its own ancestor');
  assert.deepEqual(createdIds, [food!.id, bar!.id]);
  assert.equal(bar!.parentId, food!.id, 'Bar is reachable from the returned chain');
  assert.equal(food!.parentId, null);
  assert.equal(await Category.count({ where: { householdId } }), 2, 'no extra rows');
});

test('the repeated-name truncation uses the name_key normalizer, so case does not evade it', async () => {
  const { leafId, createdIds } = await resolveCategoryPath(householdId, 'Food / bar / FOOD');
  const bar = await Category.findOne({ where: { householdId, nameKey: 'bar' } });
  assert.equal(leafId, bar!.id);
  assert.equal(createdIds.length, 2);
  assert.equal(await Category.count({ where: { householdId } }), 2);
});

test('the create is wrapped in a SAVEPOINT so a unique violation cannot abort the outer transaction', async () => {
  // Evidence for the concurrency-retry fix: on Postgres a unique violation
  // without a SAVEPOINT aborts the whole transaction (SQLSTATE 25P02) and the
  // re-lookup in resolvePath.ts would itself throw. This asserts the SAVEPOINT
  // statement is actually emitted. It cannot assert Postgres's abort semantics —
  // unit tests run on SQLite, which has no aborted-transaction state.
  const sql: string[] = [];
  const original = sequelize.options.logging;
  sequelize.options.logging = (line: string) => {
    sql.push(line);
  };
  try {
    await resolveCategoryPath(householdId, 'Work / Internet');
  } finally {
    sequelize.options.logging = original;
  }
  const savepoints = sql.filter((line) => /SAVEPOINT/.test(line));
  assert.equal(savepoints.length, 2, `one SAVEPOINT per created node, got: ${savepoints.join(' | ')}`);
});
