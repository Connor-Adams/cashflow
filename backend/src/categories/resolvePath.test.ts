// backend/src/categories/resolvePath.test.ts
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { sequelize } from '../db';
import { Category, Household } from '../models';
import { resolveCategoryPath } from './resolvePath';

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

test('duplicate names resolve deterministically to the LOWEST (oldest) id', async () => {
  // Prod shape until the Task 6 merge migration lands: the partial indexes let a
  // root "Ai" coexist with a nested "Subscriptions / Ai". An unordered LIMIT 1
  // would return whichever row the planner handed back; the resolver must always
  // pick the oldest, matching the merge planner's lowest-id tie-break.
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
  // and it collides with this duplicate root under
  // categories_household_root_name_key_unique. The DROP then fails with
  // "UNIQUE constraint failed: categories.household_id, categories.name_key"
  // and breaks the NEXT test's beforeEach. Drop the childless duplicate here so
  // the leftover shape is one the drop can unwind.
  await duplicateRoot.destroy();
});

test('a path that repeats a name is rejected and creates nothing', async () => {
  // Before the rejection this returned { leafId: <root Food>, createdIds: [<Bar>] }:
  // a leaf that is an ANCESTOR of the node the same call created, leaving "Bar"
  // dangling and empty.
  await assert.rejects(
    () => resolveCategoryPath(householdId, 'Food / Bar / Food'),
    /invalid category path/,
  );
  assert.equal(await Category.count({ where: { householdId } }), 0, 'no partial rows');

  await assert.rejects(
    () => resolveCategoryPath(householdId, 'Food / bar / FOOD'),
    /invalid category path/,
  );
  assert.equal(await Category.count({ where: { householdId } }), 0, 'no partial rows');
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
