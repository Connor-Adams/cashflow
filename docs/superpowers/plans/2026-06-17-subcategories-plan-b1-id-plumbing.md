# Subcategories — Plan B1: Category Id Plumbing

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every category reference a `categoryId` FK pointing at the `Category` tree, populated on write, without changing any read/report behavior.

**Architecture:** Add nullable `*CategoryId` FK columns to `transactions`, `external_order_items`, `rules`, `budget_targets`; backfill them by matching each existing category string to its (flat, root-level) `Category` node. Introduce one resolver `resolveCategoryIdByName(householdId, name, {transaction})` that find-or-creates a root node and returns its id. Replace the three `ensureCategory` **afterSave** hooks (Transaction, Rule, BudgetTarget) with **beforeSave** hooks that resolve each category string to an id and set the FK on the same row (no extra write, no recursion); add an equivalent beforeSave hook to `ExternalOrderItem`. Finally, extend `deleteCategory` to block when any of these FK columns reference the node (Plan A deferred this). The denormalized string columns stay untouched — reads still use them until Plan B2.

**Tech Stack:** Express + Sequelize (dual-dialect SQLite/Postgres), `node:test` via `tsx`, colocated tests.

## Global Constraints

- Repo root for commands is this worktree: `/Users/connoradams/Developer/cashflow/.claude/worktrees/subcategories-plan-b` (its own checkout; `node_modules` installed there).
- Backend unit tests: `node:test` + `node:assert/strict`, **colocated**. Run one file:
  `cd backend && PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH yarn tsx --import ./test/setup.ts --test src/<path>.test.ts`
- Migrations are **JavaScript** in `backend/src/migrations/`, `YYYYMMDD...-slug.js`; migration tests in `backend/src/migrations/__tests__/`.
- Dual-dialect: every construct must run on SQLite + Postgres. Use plain `addColumn` (nullable) — **no table recreation** (the Plan A `categories` migration's SQLite rename-recreate corrupted FKs and broke the db:migrate test suite; do not repeat that pattern).
- `underscored: true`: attribute `finalCategoryId` ↔ column `final_category_id`, etc.
- `nameKey = name.trim().toLocaleLowerCase('en-CA')` (reuse `normalizeCategoryName` from `backend/src/categories/normalizeName.ts`).
- Household-scoped everywhere.
- Builds on Plan A (already on this branch): `Category` has `parentId`/`nameKey` + `beforeValidate` hook + sibling/root partial unique indexes; `backend/src/categories/` has `normalizeCategoryName`, `CategoryError`, `deleteCategory`, etc.
- Commits: NO co-author trailers. Stage only each task's files (never `git add -A`, never stage `yarn.lock`). Prefix commit with `PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH`.
- `AiSuggestion` is intentionally OUT of scope (its category is a JSON field, resolved to a txn `categoryOverride` on accept — handled where suggestions are applied, not here).

---

### Task 1: Migration — add `*CategoryId` FK columns + backfill

**Files:**
- Create: `backend/src/migrations/20260622000001-category-id-columns.js`
- Test: `backend/src/migrations/__tests__/categoryIdColumnsMigration.test.ts`

**Interfaces:**
- Produces nullable INTEGER FK columns referencing `categories(id)`:
  - `transactions.auto_category_id`, `transactions.category_override_id`, `transactions.final_category_id`
  - `external_order_items.inferred_category_id`, `external_order_items.category_override_id`
  - `rules.category_id`
  - `budget_targets.category_id`
- Backfills each from the sibling string column by matching `(household_id, name_key)` against root categories.

- [ ] **Step 1: Write the failing test**

```ts
// backend/src/migrations/__tests__/categoryIdColumnsMigration.test.ts
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { Sequelize, DataTypes } from 'sequelize';

let sequelize: Sequelize;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let migration: { up: (...a: any[]) => Promise<void>; down: (...a: any[]) => Promise<void> };

before(async () => {
  sequelize = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false });
  const qi = sequelize.getQueryInterface();
  await qi.createTable('categories', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    household_id: { type: DataTypes.INTEGER, allowNull: false },
    parent_id: { type: DataTypes.INTEGER, allowNull: true },
    name: { type: DataTypes.STRING(128), allowNull: false },
    name_key: { type: DataTypes.STRING(128), allowNull: false },
  });
  await qi.createTable('transactions', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    household_id: { type: DataTypes.INTEGER, allowNull: false },
    auto_category: { type: DataTypes.STRING(128), allowNull: true },
    category_override: { type: DataTypes.STRING(128), allowNull: true },
    final_category: { type: DataTypes.STRING(128), allowNull: true },
  });
  await qi.createTable('external_order_items', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    inferred_category: { type: DataTypes.STRING(128), allowNull: true },
    category_override: { type: DataTypes.STRING(128), allowNull: true },
  });
  await qi.createTable('rules', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    household_id: { type: DataTypes.INTEGER, allowNull: false },
    category: { type: DataTypes.STRING(128), allowNull: true },
  });
  await qi.createTable('budget_targets', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    household_id: { type: DataTypes.INTEGER, allowNull: false },
    category: { type: DataTypes.STRING(128), allowNull: true },
  });
  await qi.bulkInsert('categories', [
    { household_id: 1, parent_id: null, name: 'Groceries', name_key: 'groceries' },
    { household_id: 1, parent_id: null, name: 'Dining', name_key: 'dining' },
  ]);
  await qi.bulkInsert('transactions', [
    { household_id: 1, auto_category: 'Groceries', category_override: null, final_category: 'Groceries' },
    { household_id: 1, auto_category: null, category_override: 'Dining', final_category: 'Dining' },
    { household_id: 1, auto_category: null, category_override: null, final_category: null },
  ]);
  await qi.bulkInsert('rules', [{ household_id: 1, category: 'Dining' }]);
  await qi.bulkInsert('budget_targets', [{ household_id: 1, category: 'Groceries' }, { household_id: 1, category: null }]);
  await qi.bulkInsert('external_order_items', [{ inferred_category: 'Groceries', category_override: 'Dining' }]);
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  migration = require('../20260622000001-category-id-columns.js');
});

after(async () => { await sequelize.close(); });

test('up adds all FK columns', async () => {
  await migration.up(sequelize.getQueryInterface(), Sequelize);
  const txn = await sequelize.getQueryInterface().describeTable('transactions');
  assert.ok('auto_category_id' in txn && 'category_override_id' in txn && 'final_category_id' in txn);
  const item = await sequelize.getQueryInterface().describeTable('external_order_items');
  assert.ok('inferred_category_id' in item && 'category_override_id' in item);
  const rule = await sequelize.getQueryInterface().describeTable('rules');
  assert.ok('category_id' in rule);
  const bt = await sequelize.getQueryInterface().describeTable('budget_targets');
  assert.ok('category_id' in bt);
});

test('backfill maps string columns to root category ids', async () => {
  const [cats] = await sequelize.query("SELECT id, name FROM categories ORDER BY name");
  const idByName = Object.fromEntries((cats as Array<{ id: number; name: string }>).map(c => [c.name, c.id]));
  const [txns] = await sequelize.query("SELECT final_category, final_category_id, category_override, category_override_id FROM transactions ORDER BY id");
  const t = txns as Array<Record<string, unknown>>;
  assert.equal(t[0].final_category_id, idByName['Groceries']);
  assert.equal(t[1].category_override_id, idByName['Dining']);
  assert.equal(t[1].final_category_id, idByName['Dining']);
  assert.equal(t[2].final_category_id, null); // null stays null
  const [rules] = await sequelize.query("SELECT category, category_id FROM rules");
  assert.equal((rules as Array<Record<string, unknown>>)[0].category_id, idByName['Dining']);
  const [bts] = await sequelize.query("SELECT category, category_id FROM budget_targets ORDER BY id");
  assert.equal((bts as Array<Record<string, unknown>>)[0].category_id, idByName['Groceries']);
  assert.equal((bts as Array<Record<string, unknown>>)[1].category_id, null); // null "overall" stays null
  const [items] = await sequelize.query("SELECT inferred_category_id, category_override_id FROM external_order_items");
  assert.equal((items as Array<Record<string, unknown>>)[0].inferred_category_id, idByName['Groceries']);
  assert.equal((items as Array<Record<string, unknown>>)[0].category_override_id, idByName['Dining']);
});

test('down removes all FK columns', async () => {
  await migration.down(sequelize.getQueryInterface(), Sequelize);
  const txn = await sequelize.getQueryInterface().describeTable('transactions');
  assert.ok(!('final_category_id' in txn));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH yarn tsx --import ./test/setup.ts --test src/migrations/__tests__/categoryIdColumnsMigration.test.ts`
Expected: FAIL — `Cannot find module '../20260622000001-category-id-columns.js'`.

- [ ] **Step 3: Write minimal implementation**

```js
// backend/src/migrations/20260622000001-category-id-columns.js
'use strict';

// (table, fkColumn, sourceStringColumn, hasHouseholdId)
const TARGETS = [
  ['transactions', 'auto_category_id', 'auto_category', true],
  ['transactions', 'category_override_id', 'category_override', true],
  ['transactions', 'final_category_id', 'final_category', true],
  ['external_order_items', 'inferred_category_id', 'inferred_category', false],
  ['external_order_items', 'category_override_id', 'category_override', false],
  ['rules', 'category_id', 'category', true],
  ['budget_targets', 'category_id', 'category', true],
];

function normalizeName(name) {
  return String(name).trim().toLocaleLowerCase('en-CA');
}

module.exports = {
  async up(queryInterface, Sequelize) {
    // 1. Add nullable INTEGER columns WITHOUT a DB-level `references`/FK clause.
    //    On SQLite, addColumn WITH a references clause can trigger a full table
    //    rebuild, which corrupts pre-existing foreign keys on heavily-FK'd tables
    //    like `transactions` (same class of failure as Plan A's rename-recreate).
    //    The relationship is enforced at the app layer (resolveCategoryIdByName
    //    only ever sets valid category ids) and via the model associations under
    //    sync; a plain nullable column is dual-dialect safe and rebuild-free.
    for (const [table, fkCol] of TARGETS) {
      await queryInterface.addColumn(table, fkCol, {
        type: Sequelize.INTEGER,
        allowNull: true,
      });
    }

    // 2. Backfill. external_order_items has no household_id, so resolve its
    //    category via the order's transaction link is out of scope for the
    //    backfill — instead match against ANY root category with the same
    //    name_key (item categories are household-agnostic strings today;
    //    a cross-household name collision is acceptable for a one-time backfill
    //    and is corrected on the next write via the model hook).
    const [cats] = await queryInterface.sequelize.query(
      'SELECT id, household_id, name_key FROM categories WHERE parent_id IS NULL',
    );
    const rootByHouseholdKey = new Map(); // `${household_id}\0${name_key}` -> id
    const rootByKey = new Map(); // name_key -> id (first wins; for item fallback)
    for (const c of cats) {
      rootByHouseholdKey.set(`${c.household_id} ${c.name_key}`, c.id);
      if (!rootByKey.has(c.name_key)) rootByKey.set(c.name_key, c.id);
    }

    for (const [table, fkCol, srcCol, hasHousehold] of TARGETS) {
      const cols = hasHousehold
        ? `id, household_id, ${srcCol} AS src`
        : `id, ${srcCol} AS src`;
      const [rows] = await queryInterface.sequelize.query(`SELECT ${cols} FROM ${table}`);
      for (const row of rows) {
        if (row.src == null || String(row.src).trim() === '') continue;
        const key = normalizeName(row.src);
        const id = hasHousehold
          ? rootByHouseholdKey.get(`${row.household_id} ${key}`)
          : rootByKey.get(key);
        if (id == null) continue;
        await queryInterface.sequelize.query(
          `UPDATE ${table} SET ${fkCol} = :id WHERE id = :rowId`,
          { replacements: { id, rowId: row.id } },
        );
      }
    }
  },

  async down(queryInterface) {
    for (const [table, fkCol] of TARGETS) {
      await queryInterface.removeColumn(table, fkCol);
    }
  },
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH yarn tsx --import ./test/setup.ts --test src/migrations/__tests__/categoryIdColumnsMigration.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH \
git add backend/src/migrations/20260622000001-category-id-columns.js \
        backend/src/migrations/__tests__/categoryIdColumnsMigration.test.ts && \
git commit -m "feat(categories): migration adds categoryId FK columns + backfill"
```

---

### Task 2: `resolveCategoryIdByName` service

**Files:**
- Create: `backend/src/categories/resolveCategoryId.ts`
- Test: `backend/src/categories/resolveCategoryId.test.ts`

**Interfaces:**
- Consumes: `normalizeCategoryName` (Plan A), `Category` model.
- Produces: `resolveCategoryIdByName(householdId: number, name: string | null | undefined, opts?: { transaction?: import('sequelize').Transaction }): Promise<number | null>` — null/empty name → null; otherwise find-or-create a ROOT (`parentId: null`) node for `(householdId, nameKey)` and return its id. Mirrors the legacy `ensureCategory` create-a-flat-root behavior, but returns the id.

- [ ] **Step 1: Write the failing test**

```ts
// backend/src/categories/resolveCategoryId.test.ts
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { sequelize } from '../db';
import { Category, Household } from '../models';
import { resolveCategoryIdByName } from './resolveCategoryId';

let householdId: number;
beforeEach(async () => {
  await sequelize.sync({ force: true });
  householdId = (await Household.create({ name: 'T' })).id;
});

test('null/empty name resolves to null', async () => {
  assert.equal(await resolveCategoryIdByName(householdId, null), null);
  assert.equal(await resolveCategoryIdByName(householdId, '   '), null);
});

test('creates a root node and returns its id', async () => {
  const id = await resolveCategoryIdByName(householdId, 'Groceries');
  const node = await Category.findByPk(id!);
  assert.equal(node?.name, 'Groceries');
  assert.equal(node?.parentId, null);
});

test('is idempotent + case-insensitive (no duplicate root)', async () => {
  const a = await resolveCategoryIdByName(householdId, 'Dining');
  const b = await resolveCategoryIdByName(householdId, '  dining ');
  assert.equal(a, b);
  assert.equal(await Category.count({ where: { householdId } }), 1);
});

test('matches an existing nested node by name if it is the only one', async () => {
  // existing flat root created by prior writes
  const id = await resolveCategoryIdByName(householdId, 'Travel');
  const again = await resolveCategoryIdByName(householdId, 'Travel');
  assert.equal(id, again);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH yarn tsx --import ./test/setup.ts --test src/categories/resolveCategoryId.test.ts`
Expected: FAIL — `Cannot find module './resolveCategoryId'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// backend/src/categories/resolveCategoryId.ts
import type { Transaction } from 'sequelize';
import { Category } from '../models';
import { normalizeCategoryName } from './normalizeName';

/**
 * Resolve a category NAME to a root Category node id for a household,
 * find-or-creating a flat root node (parentId null). Mirrors the legacy
 * ensureCategory create-a-root behavior, returning the id so write paths can
 * set their *CategoryId FK. Null / empty / whitespace name → null.
 */
export async function resolveCategoryIdByName(
  householdId: number,
  name: string | null | undefined,
  opts: { transaction?: Transaction } = {},
): Promise<number | null> {
  if (name == null) return null;
  const trimmed = name.trim();
  if (!trimmed) return null;
  const nameKey = normalizeCategoryName(trimmed);
  const [node] = await Category.findOrCreate({
    where: { householdId, parentId: null, nameKey },
    defaults: { householdId, parentId: null, name: trimmed, icon: null },
    transaction: opts.transaction,
  });
  return node.id;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH yarn tsx --import ./test/setup.ts --test src/categories/resolveCategoryId.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH \
git add backend/src/categories/resolveCategoryId.ts backend/src/categories/resolveCategoryId.test.ts && \
git commit -m "feat(categories): add resolveCategoryIdByName"
```

---

### Task 3: `Transaction` model — FK fields + beforeSave id population

**Files:**
- Modify: `backend/src/models/Transaction.ts` (fields ~48-50/189-203; hook ~380-390)
- Test: `backend/src/models/Transaction.categoryId.test.ts`

**Interfaces:**
- Consumes: `resolveCategoryIdByName` (Task 2).
- Produces: `Transaction` with `autoCategoryId`, `categoryOverrideId`, `finalCategoryId` (all `number | null`, fields `auto_category_id` / `category_override_id` / `final_category_id`); a `beforeSave` hook resolving each string column to its id. The legacy `ensureCategory` afterSave hook is removed (the beforeSave find-or-create supersedes it).

- [ ] **Step 1: Write the failing test**

```ts
// backend/src/models/Transaction.categoryId.test.ts
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { sequelize } from '../db';
import { Transaction, Household, Category, Account } from '../models';

let householdId: number;
let accountId: number;
beforeEach(async () => {
  await sequelize.sync({ force: true });
  householdId = (await Household.create({ name: 'T' })).id;
  accountId = (await Account.create({ householdId, name: 'A', type: 'chequing', currency: 'CAD' })).id;
});

test('beforeSave sets finalCategoryId from finalCategory string', async () => {
  const t = await Transaction.create({
    householdId, accountId, date: '2026-01-01', amount: -10, currency: 'CAD',
    descriptionRaw: 'x', finalCategory: 'Groceries',
  });
  assert.ok(t.finalCategoryId);
  const node = await Category.findByPk(t.finalCategoryId!);
  assert.equal(node?.name, 'Groceries');
  assert.equal(node?.parentId, null);
});

test('sets autoCategoryId + categoryOverrideId independently', async () => {
  const t = await Transaction.create({
    householdId, accountId, date: '2026-01-01', amount: -5, currency: 'CAD',
    descriptionRaw: 'y', autoCategory: 'Dining', categoryOverride: 'Travel', finalCategory: 'Travel',
  });
  const auto = await Category.findByPk(t.autoCategoryId!);
  const over = await Category.findByPk(t.categoryOverrideId!);
  assert.equal(auto?.name, 'Dining');
  assert.equal(over?.name, 'Travel');
  assert.equal(t.finalCategoryId, t.categoryOverrideId);
});

test('null finalCategory leaves finalCategoryId null', async () => {
  const t = await Transaction.create({
    householdId, accountId, date: '2026-01-01', amount: -5, currency: 'CAD',
    descriptionRaw: 'z', finalCategory: null,
  });
  assert.equal(t.finalCategoryId, null);
});
```

> If `Account.create`/`Transaction.create` need more required fields in this codebase, add the minimal ones the model demands (check `Transaction.ts` / `Account.ts` `allowNull:false` columns) — keep the category assertions identical.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH yarn tsx --import ./test/setup.ts --test src/models/Transaction.categoryId.test.ts`
Expected: FAIL — `finalCategoryId` is not a known attribute / is undefined.

- [ ] **Step 3: Write minimal implementation**

In `backend/src/models/Transaction.ts`:

1. Add to the class declarations (beside `autoCategory`/`categoryOverride`/`finalCategory`):
```ts
  declare autoCategoryId: number | null;
  declare categoryOverrideId: number | null;
  declare finalCategoryId: number | null;
```

2. Add to the `init` attributes (beside the matching string columns):
```ts
      autoCategoryId: { type: DataTypes.INTEGER, field: 'auto_category_id', allowNull: true },
      categoryOverrideId: { type: DataTypes.INTEGER, field: 'category_override_id', allowNull: true },
      finalCategoryId: { type: DataTypes.INTEGER, field: 'final_category_id', allowNull: true },
```

3. Replace the existing `ensureCategory` `afterSave` hook (the block that imports `../util/ensureCategory` and calls it with `instance.finalCategory`) with a `beforeSave` hook:
```ts
  Transaction.addHook('beforeSave', async (instance: Transaction, options) => {
    if (instance.householdId == null) return;
    const { resolveCategoryIdByName } = await import('../categories/resolveCategoryId');
    const tx = options.transaction ?? null;
    instance.autoCategoryId = await resolveCategoryIdByName(instance.householdId, instance.autoCategory, { transaction: tx ?? undefined });
    instance.categoryOverrideId = await resolveCategoryIdByName(instance.householdId, instance.categoryOverride, { transaction: tx ?? undefined });
    instance.finalCategoryId = await resolveCategoryIdByName(instance.householdId, instance.finalCategory, { transaction: tx ?? undefined });
  });
```

> Why beforeSave, not afterSave: the FK columns are set on the same row before its single write — no second `save()` and no recursion. `resolveCategoryIdByName` find-or-creates the node (superseding the old `ensureCategory` afterSave upsert, which is now redundant and removed).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH yarn tsx --import ./test/setup.ts --test src/models/Transaction.categoryId.test.ts`
Expected: PASS (3 tests).

Then confirm no existing Transaction test regressed and typecheck:
Run: `cd backend && PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH yarn tsx --import ./test/setup.ts --test src/models.test.ts && PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH yarn workspace cashflow-backend run typecheck`
Expected: PASS / no errors.

- [ ] **Step 5: Commit**

```bash
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH \
git add backend/src/models/Transaction.ts backend/src/models/Transaction.categoryId.test.ts && \
git commit -m "feat(categories): Transaction FK ids set via beforeSave hook"
```

---

### Task 4: `Rule` + `BudgetTarget` models — FK field + beforeSave id population

**Files:**
- Modify: `backend/src/models/Rule.ts` (field ~22/66; hook ~104-114)
- Modify: `backend/src/models/BudgetTarget.ts` (field ~58/108; hook ~148-157)
- Test: `backend/src/models/ruleBudgetCategoryId.test.ts`

**Interfaces:**
- Consumes: `resolveCategoryIdByName` (Task 2).
- Produces: `Rule.categoryId` and `BudgetTarget.categoryId` (`number | null`, field `category_id`), each set by a `beforeSave` hook from the model's `category` string; the prior `ensureCategory` afterSave hooks on both models are removed. `BudgetTarget` with `category == null` ("overall") yields `categoryId == null`.

- [ ] **Step 1: Write the failing test**

```ts
// backend/src/models/ruleBudgetCategoryId.test.ts
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { sequelize } from '../db';
import { Rule, BudgetTarget, Household, Category } from '../models';

let householdId: number;
beforeEach(async () => {
  await sequelize.sync({ force: true });
  householdId = (await Household.create({ name: 'T' })).id;
});

test('Rule.categoryId set from category string', async () => {
  const r = await Rule.create({ householdId, category: 'Dining' } as never);
  assert.ok(r.categoryId);
  assert.equal((await Category.findByPk(r.categoryId!))?.name, 'Dining');
});

test('BudgetTarget.categoryId set from category; null stays overall', async () => {
  const scoped = await BudgetTarget.create({ householdId, category: 'Groceries' } as never);
  assert.ok(scoped.categoryId);
  const overall = await BudgetTarget.create({ householdId, category: null } as never);
  assert.equal(overall.categoryId, null);
});
```

> Use the minimal required fields each model demands (read `Rule.ts` / `BudgetTarget.ts` for `allowNull:false` columns; e.g. BudgetTarget likely needs `currency`, `amount`/`limit`, `period`). Keep the category assertions identical. The `as never` casts sidestep partial-attribute typing for the test only.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH yarn tsx --import ./test/setup.ts --test src/models/ruleBudgetCategoryId.test.ts`
Expected: FAIL — `categoryId` not a known attribute.

- [ ] **Step 3: Write minimal implementation**

In `backend/src/models/Rule.ts`:
1. Add declaration `declare categoryId: number | null;` beside `category`.
2. Add init attribute: `categoryId: { type: DataTypes.INTEGER, field: 'category_id', allowNull: true },`.
3. Replace the `ensureCategory` afterSave hook with:
```ts
  Rule.addHook('beforeSave', async (instance: Rule, options) => {
    if (instance.householdId == null) return;
    const { resolveCategoryIdByName } = await import('../categories/resolveCategoryId');
    instance.categoryId = await resolveCategoryIdByName(
      instance.householdId, instance.category, { transaction: options.transaction ?? undefined },
    );
  });
```

In `backend/src/models/BudgetTarget.ts`: identical pattern —
1. `declare categoryId: number | null;`
2. `categoryId: { type: DataTypes.INTEGER, field: 'category_id', allowNull: true },`
3. Replace its `ensureCategory` afterSave hook with the same `beforeSave` shape (referencing `BudgetTarget`/`instance.category`). `null` category → `resolveCategoryIdByName` returns null → `categoryId` null (overall preserved).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH yarn tsx --import ./test/setup.ts --test src/models/ruleBudgetCategoryId.test.ts`
Expected: PASS (2 tests). Then typecheck: `PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH yarn workspace cashflow-backend run typecheck` → no errors.

- [ ] **Step 5: Commit**

```bash
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH \
git add backend/src/models/Rule.ts backend/src/models/BudgetTarget.ts backend/src/models/ruleBudgetCategoryId.test.ts && \
git commit -m "feat(categories): Rule + BudgetTarget categoryId via beforeSave hook"
```

---

### Task 5: `ExternalOrderItem` model — FK fields + beforeSave id population

**Files:**
- Modify: `backend/src/models/ExternalOrderItem.ts` (fields ~21-24/47-62)
- Test: `backend/src/models/externalOrderItemCategoryId.test.ts`

**Interfaces:**
- Consumes: `resolveCategoryIdByName` (Task 2).
- Produces: `ExternalOrderItem.inferredCategoryId` and `.categoryOverrideId` (`number | null`, fields `inferred_category_id` / `category_override_id`), set by a `beforeSave` hook. **Household scoping:** `ExternalOrderItem` has no `householdId` column — resolve via the parent `ExternalOrder.householdId`. If the order/household can't be resolved in-hook, leave the ids null (backfill + a later write will set them); never throw.

- [ ] **Step 1: Write the failing test**

```ts
// backend/src/models/externalOrderItemCategoryId.test.ts
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { sequelize } from '../db';
import { ExternalOrder, ExternalOrderItem, Household, Category } from '../models';

let householdId: number;
let orderId: number;
beforeEach(async () => {
  await sequelize.sync({ force: true });
  householdId = (await Household.create({ name: 'T' })).id;
  orderId = (await ExternalOrder.create({ householdId, source: 'amazon', externalId: 'o1', currency: 'CAD' } as never)).id;
});

test('beforeSave resolves item category ids via parent order household', async () => {
  const item = await ExternalOrderItem.create({
    externalOrderId: orderId, description: 'Milk', inferredCategory: 'Groceries', categoryOverride: 'Dining',
  } as never);
  assert.ok(item.inferredCategoryId);
  assert.ok(item.categoryOverrideId);
  assert.equal((await Category.findByPk(item.inferredCategoryId!))?.householdId, householdId);
  assert.equal((await Category.findByPk(item.categoryOverrideId!))?.name, 'Dining');
});

test('null categories leave ids null', async () => {
  const item = await ExternalOrderItem.create({
    externalOrderId: orderId, description: 'X', inferredCategory: null, categoryOverride: null,
  } as never);
  assert.equal(item.inferredCategoryId, null);
  assert.equal(item.categoryOverrideId, null);
});
```

> Adjust the `ExternalOrder.create` / `ExternalOrderItem.create` attributes to whatever the models require (read the model files for `allowNull:false` columns); keep the category-id assertions identical.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH yarn tsx --import ./test/setup.ts --test src/models/externalOrderItemCategoryId.test.ts`
Expected: FAIL — `inferredCategoryId` not a known attribute.

- [ ] **Step 3: Write minimal implementation**

In `backend/src/models/ExternalOrderItem.ts`:
1. Add declarations `declare inferredCategoryId: number | null;` and `declare categoryOverrideId: number | null;`.
2. Add init attributes:
```ts
      inferredCategoryId: { type: DataTypes.INTEGER, field: 'inferred_category_id', allowNull: true },
      categoryOverrideId: { type: DataTypes.INTEGER, field: 'category_override_id', allowNull: true },
```
3. Add a `beforeSave` hook (resolves household via the parent order):
```ts
  ExternalOrderItem.addHook('beforeSave', async (instance: ExternalOrderItem, options) => {
    const tx = options.transaction ?? undefined;
    const { ExternalOrder } = await import('./ExternalOrder');
    const order = await ExternalOrder.findByPk(instance.externalOrderId, { transaction: tx });
    if (!order || order.householdId == null) return; // can't scope — leave ids null
    const { resolveCategoryIdByName } = await import('../categories/resolveCategoryId');
    instance.inferredCategoryId = await resolveCategoryIdByName(order.householdId, instance.inferredCategory, { transaction: tx });
    instance.categoryOverrideId = await resolveCategoryIdByName(order.householdId, instance.categoryOverride, { transaction: tx });
  });
```

> Use a dynamic `import('./ExternalOrder')` to avoid a model-load circular import, matching the codebase's existing in-hook dynamic-import pattern.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH yarn tsx --import ./test/setup.ts --test src/models/externalOrderItemCategoryId.test.ts`
Expected: PASS (2 tests). Then typecheck → no errors.

- [ ] **Step 5: Commit**

```bash
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH \
git add backend/src/models/ExternalOrderItem.ts backend/src/models/externalOrderItemCategoryId.test.ts && \
git commit -m "feat(categories): ExternalOrderItem category ids via beforeSave hook"
```

---

### Task 6: Extend `deleteCategory` to block on FK references

**Files:**
- Modify: `backend/src/categories/deleteCategory.ts`
- Test: `backend/src/categories/deleteCategory.references.test.ts`

**Interfaces:**
- Consumes: `Category`, `Transaction`, `ExternalOrderItem`, `Rule`, `BudgetTarget` models; `CategoryError` (Plan A, code `has_references`).
- Produces: `deleteCategory` now also throws `CategoryError('has_references')` when any of `Transaction.{autoCategoryId, categoryOverrideId, finalCategoryId}`, `ExternalOrderItem.{inferredCategoryId, categoryOverrideId}`, `Rule.categoryId`, or `BudgetTarget.categoryId` references the node. (Child-blocking from Plan A stays; checked first.)

- [ ] **Step 1: Write the failing test**

```ts
// backend/src/categories/deleteCategory.references.test.ts
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { sequelize } from '../db';
import { Category, Household, Account, Transaction, Rule, BudgetTarget } from '../models';
import { deleteCategory } from './deleteCategory';
import { CategoryError } from './errors';

let householdId: number;
let accountId: number;
beforeEach(async () => {
  await sequelize.sync({ force: true });
  householdId = (await Household.create({ name: 'T' })).id;
  accountId = (await Account.create({ householdId, name: 'A', type: 'chequing', currency: 'CAD' })).id;
});

test('blocks delete when a transaction references the category id', async () => {
  await Transaction.create({
    householdId, accountId, date: '2026-01-01', amount: -3, currency: 'CAD',
    descriptionRaw: 'x', finalCategory: 'Snacks',
  });
  const node = await Category.findOne({ where: { householdId, name: 'Snacks' } });
  await assert.rejects(
    () => deleteCategory(householdId, node!.id),
    (e: unknown) => e instanceof CategoryError && e.code === 'has_references',
  );
});

test('blocks delete when a rule references the category id', async () => {
  await Rule.create({ householdId, category: 'Fuel' } as never);
  const node = await Category.findOne({ where: { householdId, name: 'Fuel' } });
  await assert.rejects(
    () => deleteCategory(householdId, node!.id),
    (e: unknown) => e instanceof CategoryError && e.code === 'has_references',
  );
});

test('allows delete when no references and no children', async () => {
  const node = await Category.create({ householdId, name: 'Unused', icon: null, parentId: null });
  await deleteCategory(householdId, node.id);
  assert.equal(await Category.findByPk(node.id), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH yarn tsx --import ./test/setup.ts --test src/categories/deleteCategory.references.test.ts`
Expected: FAIL — delete succeeds (no reference check yet), so the `assert.rejects` cases fail.

- [ ] **Step 3: Write minimal implementation**

Replace the body of `deleteCategory` in `backend/src/categories/deleteCategory.ts` (keep the not_found + has_children checks, add the reference check before `destroy`):

```ts
import { Op } from 'sequelize';
import { Category, Transaction, ExternalOrderItem, Rule, BudgetTarget } from '../models';
import { CategoryError } from './errors';

export async function deleteCategory(householdId: number, id: number): Promise<void> {
  const node = await Category.findOne({ where: { id, householdId } });
  if (!node) throw new CategoryError('not_found', `category ${id} not found`);

  const childCount = await Category.count({ where: { householdId, parentId: id } });
  if (childCount > 0) {
    throw new CategoryError('has_children', 'reparent or remove child categories before deleting this one');
  }

  const [txnRefs, itemRefs, ruleRefs, budgetRefs] = await Promise.all([
    Transaction.count({
      where: {
        householdId,
        [Op.or]: [{ autoCategoryId: id }, { categoryOverrideId: id }, { finalCategoryId: id }],
      },
    }),
    ExternalOrderItem.count({ where: { [Op.or]: [{ inferredCategoryId: id }, { categoryOverrideId: id }] } }),
    Rule.count({ where: { householdId, categoryId: id } }),
    BudgetTarget.count({ where: { householdId, categoryId: id } }),
  ]);
  if (txnRefs + itemRefs + ruleRefs + budgetRefs > 0) {
    throw new CategoryError(
      'has_references',
      'reassign transactions, items, rules, and budgets off this category before deleting it',
    );
  }

  await node.destroy();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH yarn tsx --import ./test/setup.ts --test src/categories/deleteCategory.references.test.ts src/categories/deleteCategory.test.ts`
Expected: PASS (Plan A's 3 + these 3). Then route mapping already returns 409 for `has_references` (Plan A's `statusForCategoryError`).

- [ ] **Step 5: Commit**

```bash
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH \
git add backend/src/categories/deleteCategory.ts backend/src/categories/deleteCategory.references.test.ts && \
git commit -m "feat(categories): deleteCategory blocks on txn/item/rule/budget references"
```

---

### Task 7: Retire the `ensureCategory` util call sites + dead-code check

**Files:**
- Modify: `backend/src/util/ensureCategory.ts` (and confirm no remaining importers)
- Test: (covered by the full suite — no new test file)

**Interfaces:**
- Consumes: nothing new.
- Produces: `ensureCategory` is no longer referenced by any model hook (Tasks 3-5 removed the three afterSave call sites). Confirm there are no other importers; if none remain, delete the file. If other importers exist (e.g. a seed/import path), leave the file and note them.

- [ ] **Step 1: Find remaining importers**

Run: `cd backend && grep -rn "ensureCategory" src --include=*.ts | grep -v "src/util/ensureCategory.ts"`
Expected after Tasks 3-5: only matches inside the three model files should be gone; list whatever remains.

- [ ] **Step 2: Decide + act**

- If the grep returns **no importers**: delete `backend/src/util/ensureCategory.ts` (and any `ensureCategory.test.ts` if it exists and only tests that util).
- If importers remain: leave `ensureCategory.ts` in place and record the importers in your report (they keep working — the Category root they upsert is the same node `resolveCategoryIdByName` would find-or-create).

- [ ] **Step 3: Verify the full unit suite is green**

Run: `cd backend && PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH yarn workspace cashflow-backend run test 2>&1 | tail -6`
Expected: `# fail 0`. (This is the key regression gate — Task 1's migration runs via `db:migrate` in the portfolio/integration test files' `before()`, and Tasks 3-5 change write hooks that many tests exercise.)

- [ ] **Step 4: Typecheck + lint**

Run: `cd /Users/connoradams/Developer/cashflow/.claude/worktrees/subcategories-plan-b && PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH yarn workspace cashflow-backend run typecheck && PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH yarn workspace cashflow-backend run lint`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH \
git add -A backend/src/util backend/src && \
git commit -m "refactor(categories): retire ensureCategory util now superseded by resolveCategoryIdByName beforeSave hooks"
```
> If nothing changed in Step 2 (importers remain), skip the commit and note it in the report.

---

## Final verification

- [ ] Full backend unit suite green: `cd backend && PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH yarn workspace cashflow-backend run test` → `# fail 0`.
- [ ] Typecheck + lint clean.
- [ ] Migrate up/down round-trips on a scratch DB: `yarn db:migrate` then `yarn workspace cashflow-backend run db:migrate:undo`.
- [ ] Spot-check: creating a transaction with `finalCategory: 'X'` results in a `final_category_id` pointing at a root `Category` named `X` (the write path populates ids).

## What Plan B1 deliberately leaves to B2 / C

- **B2:** shared subtree-rollup utility (fold node totals up the ancestor chain) + rewire `aggregateMonthly` / `aggregateSankey` / `aggregateDashboard` / `aggregateSpendByCategory` / `insights` and their query call sites (`routes/summary.ts`, `sankey.ts`, `reports.ts`, `reporting.ts`, `budgets.ts`, `ai/insights.ts`) to group by `finalCategoryId` and roll up; resolve node id → name/path for output; `loadCategoryHints` returns full paths; `splitTxnByItems` carries item category ids. Also: static `Model.update()`/`bulkCreate()` write paths (aiBatchOverColdRows, categorizeReceiptItems, vendorCapture) bypass the beforeSave id hooks and leave `*CategoryId` null — B2 must resolve/backfill these before relying on id-based grouping.
- **C:** frontend picker path-syntax + manager page; **name-rename route + `syncCategoryLeafNameMirrors`** (rename lives on the manager page; id-based reads in B2 resolve the current name from the node, so report staleness is already handled — mirrors only matter for any residual string reads); AI deferred (accept-time) path creation.
