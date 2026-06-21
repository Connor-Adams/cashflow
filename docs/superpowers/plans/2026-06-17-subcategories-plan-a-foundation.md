# Subcategories — Plan A: Category Tree Foundation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the flat `Category` table into an arbitrary-depth tree (self-FK `parentId`) with durable case-insensitive sibling-unique names (`nameKey`), and expose a category service + `/api/categories/*` routes to create, resolve-by-path, reparent, and delete nodes.

**Architecture:** `Category` gains a nullable self-referential `parentId` and a persisted normalized `nameKey`. Uniqueness moves from `(household_id, name)` to two partial unique indexes on `name_key` (sibling + root). A new `backend/src/categories/` service owns name normalization, path parsing/resolution (concurrency-safe), cycle detection, reparenting, and delete-blocking. Routes are thin wrappers over the service. This plan does NOT change how transactions reference categories (still the `finalCategory` string) — that id migration is Plan B.

**Tech Stack:** Express + Sequelize (dual-dialect SQLite/Postgres), `node:test` via `tsx` for unit tests, `supertest` + Postgres for the integration test.

## Global Constraints

- Run all commands from the **repo root** (yarn-1 workspaces hoist to root).
- Backend unit tests: `node:test` + `node:assert/strict`, **colocated** beside source (`foo.test.ts` beside `foo.ts`). Run one file with `cd backend && yarn tsx --import ./test/setup.ts --test src/<path>.test.ts`.
- Migrations are **JavaScript** (`module.exports = { async up, async down }`) in `backend/src/migrations/`, named `YYYYMMDD...-slug.js`. Migration tests live in `backend/src/migrations/__tests__/` (NOT in `src/migrations/`).
- Sequelize must run on **both SQLite and Postgres**. Partial unique indexes via `where` in `addIndex` are supported on both.
- Models use `underscored: true` — model attribute `parentId` ↔ DB column `parent_id`, `nameKey` ↔ `name_key`. Indexes and migrations reference **DB column names**.
- `nameKey = name.trim().toLocaleLowerCase('en-CA')`.
- Household scoping: route handlers use `householdWhere(req)` from `backend/src/auth/scope.ts`.
- Commits: NO `Co-Authored-By` / co-author trailers. Connor is sole author.
- Committing in this worktree needs lint-staged on PATH: prefix git commit with `PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH`.

---

### Task 1: `normalizeCategoryName` (pure)

**Files:**
- Create: `backend/src/categories/normalizeName.ts`
- Test: `backend/src/categories/normalizeName.test.ts`

**Interfaces:**
- Produces: `normalizeCategoryName(name: string): string` — trim + locale-lowercase, the value stored in `Category.nameKey`.

- [ ] **Step 1: Write the failing test**

```ts
// backend/src/categories/normalizeName.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCategoryName } from './normalizeName';

test('normalizeCategoryName trims and lowercases', () => {
  assert.equal(normalizeCategoryName('  Internet '), 'internet');
  assert.equal(normalizeCategoryName('INTERNET'), 'internet');
  assert.equal(normalizeCategoryName('Internet'), 'internet');
});

test('normalizeCategoryName collapses casing variants to one key', () => {
  const keys = new Set(['Internet', 'internet', 'INTERNET'].map(normalizeCategoryName));
  assert.equal(keys.size, 1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && yarn tsx --import ./test/setup.ts --test src/categories/normalizeName.test.ts`
Expected: FAIL — `Cannot find module './normalizeName'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// backend/src/categories/normalizeName.ts
/** Persisted normalization key for case-insensitive sibling uniqueness. */
export function normalizeCategoryName(name: string): string {
  return name.trim().toLocaleLowerCase('en-CA');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && yarn tsx --import ./test/setup.ts --test src/categories/normalizeName.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH \
git add backend/src/categories/normalizeName.ts backend/src/categories/normalizeName.test.ts && \
git commit -m "feat(categories): add normalizeCategoryName"
```

---

### Task 2: Migration — `parent_id`, `name_key`, partial unique indexes

**Files:**
- Create: `backend/src/migrations/20260621000001-category-tree-foundation.js`
- Test: `backend/src/migrations/__tests__/categoryTreeFoundationMigration.test.ts`

**Interfaces:**
- Produces: `categories.parent_id` (nullable INTEGER, self-FK), `categories.name_key` (STRING(128), NOT NULL); unique partial indexes `categories_household_parent_name_key_unique` (WHERE parent_id IS NOT NULL) and `categories_household_root_name_key_unique` (WHERE parent_id IS NULL); old `categories_household_id_name` index removed.

- [ ] **Step 1: Write the failing test**

```ts
// backend/src/migrations/__tests__/categoryTreeFoundationMigration.test.ts
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { Sequelize, DataTypes } from 'sequelize';

let sequelize: Sequelize;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let migration: { up: (...a: any[]) => Promise<void>; down: (...a: any[]) => Promise<void> };

before(async () => {
  sequelize = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false });
  const qi = sequelize.getQueryInterface();
  // Recreate the pre-migration shape: flat categories with the old unique index.
  await qi.createTable('categories', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    household_id: { type: DataTypes.INTEGER, allowNull: false },
    name: { type: DataTypes.STRING(128), allowNull: false },
    icon: { type: DataTypes.STRING(64), allowNull: true },
    tax_treatment: { type: DataTypes.STRING(32), allowNull: false, defaultValue: 'none' },
    created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: new Date() },
    updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: new Date() },
  });
  await qi.addIndex('categories', ['household_id', 'name'], {
    name: 'categories_household_name_unique',
    unique: true,
  });
  await qi.bulkInsert('categories', [
    { household_id: 1, name: 'Groceries', tax_treatment: 'none' },
    { household_id: 1, name: 'Dining', tax_treatment: 'none' },
  ]);
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  migration = require('../20260621000001-category-tree-foundation.js');
});

after(async () => { await sequelize.close(); });

test('up adds parent_id + name_key columns', async () => {
  await migration.up(sequelize.getQueryInterface(), Sequelize);
  const desc = await sequelize.getQueryInterface().describeTable('categories');
  assert.ok('parent_id' in desc, 'parent_id column missing');
  assert.ok('name_key' in desc, 'name_key column missing');
  assert.equal(desc.parent_id?.allowNull, true);
  assert.equal(desc.name_key?.allowNull, false);
});

test('up backfills name_key as lowercased name', async () => {
  const [rows] = await sequelize.query(
    "SELECT name, name_key FROM categories ORDER BY name",
  );
  const byName = Object.fromEntries((rows as Array<{ name: string; name_key: string }>).map(r => [r.name, r.name_key]));
  assert.equal(byName['Groceries'], 'groceries');
  assert.equal(byName['Dining'], 'dining');
});

test('root name_key uniqueness is enforced (case-insensitive)', async () => {
  await assert.rejects(
    () => sequelize.query(
      "INSERT INTO categories (household_id, name, name_key, tax_treatment) VALUES (1, 'groceries', 'groceries', 'none')",
    ),
    /UNIQUE|constraint/i,
  );
});

test('down removes new columns and restores old index', async () => {
  await migration.down(sequelize.getQueryInterface(), Sequelize);
  const desc = await sequelize.getQueryInterface().describeTable('categories');
  assert.ok(!('parent_id' in desc), 'parent_id should be dropped');
  assert.ok(!('name_key' in desc), 'name_key should be dropped');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && yarn tsx --import ./test/setup.ts --test src/migrations/__tests__/categoryTreeFoundationMigration.test.ts`
Expected: FAIL — `Cannot find module '../20260621000001-category-tree-foundation.js'`.

- [ ] **Step 3: Write minimal implementation**

```js
// backend/src/migrations/20260621000001-category-tree-foundation.js
'use strict';

function normalizeName(name) {
  return String(name).trim().toLocaleLowerCase('en-CA');
}

module.exports = {
  async up(queryInterface, Sequelize) {
    // 1. New columns (nullable first so we can backfill name_key before NOT NULL).
    await queryInterface.addColumn('categories', 'parent_id', {
      type: Sequelize.INTEGER,
      allowNull: true,
      references: { model: 'categories', key: 'id' },
      onDelete: 'RESTRICT',
    });
    await queryInterface.addColumn('categories', 'name_key', {
      type: Sequelize.STRING(128),
      allowNull: true,
    });

    // 2. Backfill name_key from name.
    const [rows] = await queryInterface.sequelize.query('SELECT id, name FROM categories');
    for (const row of rows) {
      await queryInterface.sequelize.query(
        'UPDATE categories SET name_key = :key WHERE id = :id',
        { replacements: { key: normalizeName(row.name), id: row.id } },
      );
    }

    // 3. Guard: surface pre-existing case-collisions loudly before the unique index.
    const [dupes] = await queryInterface.sequelize.query(
      'SELECT household_id, name_key, COUNT(*) AS c FROM categories ' +
        'GROUP BY household_id, name_key HAVING COUNT(*) > 1',
    );
    if (dupes.length > 0) {
      throw new Error(
        'category name_key collisions must be merged before migration: ' +
          JSON.stringify(dupes),
      );
    }

    // 4. Enforce NOT NULL on name_key now that it is populated.
    await queryInterface.changeColumn('categories', 'name_key', {
      type: Sequelize.STRING(128),
      allowNull: false,
    });

    // 5. New partial unique indexes (DB column names; partials supported on both dialects).
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

    // 6. Drop the old (household_id, name) unique index now the replacements exist.
    //    Name comes from the original create migration 20260524170001-categories.js.
    await queryInterface.removeIndex('categories', 'categories_household_name_unique');
  },

  async down(queryInterface) {
    await queryInterface.addIndex('categories', ['household_id', 'name'], {
      name: 'categories_household_name_unique',
      unique: true,
    });
    await queryInterface.removeIndex('categories', 'categories_household_parent_name_key_unique');
    await queryInterface.removeIndex('categories', 'categories_household_root_name_key_unique');
    await queryInterface.removeColumn('categories', 'name_key');
    await queryInterface.removeColumn('categories', 'parent_id');
  },
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && yarn tsx --import ./test/setup.ts --test src/migrations/__tests__/categoryTreeFoundationMigration.test.ts`
Expected: PASS (5 tests). If the root-uniqueness test errors with "no such index" instead of UNIQUE, confirm the `where: { parent_id: null }` partial index built; SQLite reports it as `SQLITE_CONSTRAINT: UNIQUE`.

- [ ] **Step 5: Commit**

```bash
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH \
git add backend/src/migrations/20260621000001-category-tree-foundation.js \
        backend/src/migrations/__tests__/categoryTreeFoundationMigration.test.ts && \
git commit -m "feat(categories): migration adds parent_id + name_key + partial unique indexes"
```

---

### Task 3: `Category` model — fields, nameKey hook, self-associations, indexes

**Files:**
- Modify: `backend/src/models/Category.ts`
- Modify: `backend/src/models/index.ts` (add self-associations)
- Test: `backend/src/models/Category.test.ts`

**Interfaces:**
- Consumes: `normalizeCategoryName` (Task 1).
- Produces: `Category` with `declare parentId: number | null` and `declare nameKey: CreationOptional<string>`; `beforeValidate` hook sets `nameKey` from `name`; associations `Category.belongsTo(Category, { as: 'parent', foreignKey: 'parent_id' })` and `Category.hasMany(Category, { as: 'children', foreignKey: 'parent_id' })`.

- [ ] **Step 1: Write the failing test**

```ts
// backend/src/models/Category.test.ts
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Op } from 'sequelize';
import { sequelize } from '../db';
import { Category, Household } from '../models';

let householdId: number;

beforeEach(async () => {
  await sequelize.sync({ force: true });
  const h = await Household.create({ name: 'T' });
  householdId = h.id;
});

test('sets name_key automatically from name', async () => {
  const c = await Category.create({ householdId, name: '  Groceries ', icon: null, parentId: null });
  assert.equal(c.nameKey, 'groceries');
});

test('same leaf name allowed under two different parents', async () => {
  const work = await Category.create({ householdId, name: 'Work', icon: null, parentId: null });
  const home = await Category.create({ householdId, name: 'Home', icon: null, parentId: null });
  await Category.create({ householdId, name: 'Internet', icon: null, parentId: work.id });
  await Category.create({ householdId, name: 'Internet', icon: null, parentId: home.id }); // must not throw
  const count = await Category.count({ where: { householdId, name: 'Internet' } });
  assert.equal(count, 2);
});

test('case-insensitive sibling uniqueness rejected', async () => {
  const work = await Category.create({ householdId, name: 'Work', icon: null, parentId: null });
  await Category.create({ householdId, name: 'Internet', icon: null, parentId: work.id });
  await assert.rejects(
    () => Category.create({ householdId, name: 'INTERNET', icon: null, parentId: work.id }),
    /UNIQUE|constraint/i,
  );
});

test('two roots with same name (any casing) rejected', async () => {
  await Category.create({ householdId, name: 'Bills', icon: null, parentId: null });
  await assert.rejects(
    () => Category.create({ householdId, name: 'bills', icon: null, parentId: null }),
    /UNIQUE|constraint/i,
  );
});

test('children association resolves', async () => {
  const work = await Category.create({ householdId, name: 'Work', icon: null, parentId: null });
  await Category.create({ householdId, name: 'Internet', icon: null, parentId: work.id });
  const kids = await Category.findAll({ where: { parentId: work.id } });
  assert.equal(kids.length, 1);
  assert.equal(kids[0].name, 'Internet');
  // silence unused import lint if Op not otherwise used
  assert.ok(Op.ne);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && yarn tsx --import ./test/setup.ts --test src/models/Category.test.ts`
Expected: FAIL — `parentId`/`nameKey` not valid attributes (or no `name_key` column / no partial index).

- [ ] **Step 3: Write minimal implementation**

Replace `backend/src/models/Category.ts` with:

```ts
import {
  Model,
  DataTypes,
  Op,
  type Sequelize,
  type ModelAttributes,
  InferAttributes,
  InferCreationAttributes,
  CreationOptional,
} from 'sequelize';
import { normalizeCategoryName } from '../categories/normalizeName';

export class Category extends Model<
  InferAttributes<Category>,
  InferCreationAttributes<Category>
> {
  declare id: CreationOptional<number>;
  declare householdId: number;
  declare parentId: number | null;
  declare name: string;
  declare nameKey: CreationOptional<string>;
  declare icon: string | null;
  declare taxTreatment: CreationOptional<string>;
  declare readonly createdAt: CreationOptional<Date>;
  declare readonly updatedAt: CreationOptional<Date>;
}

export function initCategory(sequelize: Sequelize): typeof Category {
  Category.init(
    {
      id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
      householdId: { type: DataTypes.INTEGER, field: 'household_id', allowNull: false },
      parentId: { type: DataTypes.INTEGER, field: 'parent_id', allowNull: true },
      name: { type: DataTypes.STRING(128), allowNull: false },
      nameKey: { type: DataTypes.STRING(128), field: 'name_key', allowNull: false },
      icon: { type: DataTypes.STRING(64), allowNull: true },
      taxTreatment: {
        type: DataTypes.STRING(32),
        field: 'tax_treatment',
        allowNull: false,
        defaultValue: 'none',
      },
    } as ModelAttributes<Category>,
    {
      sequelize,
      modelName: 'Category',
      tableName: 'categories',
      underscored: true,
      timestamps: true,
      hooks: {
        beforeValidate(instance: Category) {
          if (instance.name != null) {
            instance.nameKey = normalizeCategoryName(instance.name);
          }
        },
      },
      indexes: [
        {
          name: 'categories_household_parent_name_key_unique',
          unique: true,
          fields: ['household_id', 'parent_id', 'name_key'],
          where: { parent_id: { [Op.ne]: null } },
        },
        {
          name: 'categories_household_root_name_key_unique',
          unique: true,
          fields: ['household_id', 'name_key'],
          where: { parent_id: null },
        },
      ],
    }
  );
  return Category;
}
```

Then in `backend/src/models/index.ts`, after the existing association block (e.g. just after the `Transaction.belongsTo(Entity, ...)` lines near line 268), add:

```ts
// Category tree (subcategories): self-referential parent/children.
Category.belongsTo(Category, { foreignKey: 'parent_id', as: 'parent' });
Category.hasMany(Category, { foreignKey: 'parent_id', as: 'children' });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && yarn tsx --import ./test/setup.ts --test src/models/Category.test.ts`
Expected: PASS (5 tests).

Also run the backend typecheck to catch attribute typing issues:
Run: `yarn workspace cashflow-backend run typecheck`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH \
git add backend/src/models/Category.ts backend/src/models/index.ts backend/src/models/Category.test.ts && \
git commit -m "feat(categories): Category gets parentId + nameKey hook + self-associations"
```

---

### Task 4: `parseCategoryPath` (pure)

**Files:**
- Create: `backend/src/categories/path.ts`
- Test: `backend/src/categories/path.test.ts`

**Interfaces:**
- Produces: `parseCategoryPath(input: string): string[]` — splits on `/`, trims each segment, rejects empty segments. Throws `Error` with message `invalid category path` on any empty segment. A bare name → single-element array.

- [ ] **Step 1: Write the failing test**

```ts
// backend/src/categories/path.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCategoryPath } from './path';

test('splits and trims segments', () => {
  assert.deepEqual(parseCategoryPath('Work / Expenses / Internet'), ['Work', 'Expenses', 'Internet']);
  assert.deepEqual(parseCategoryPath(' Work / Internet '), ['Work', 'Internet']);
});

test('bare name is a single root segment', () => {
  assert.deepEqual(parseCategoryPath('Internet'), ['Internet']);
});

test('rejects empty segments', () => {
  assert.throws(() => parseCategoryPath('Work//Internet'), /invalid category path/);
  assert.throws(() => parseCategoryPath('Work /'), /invalid category path/);
  assert.throws(() => parseCategoryPath('  '), /invalid category path/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && yarn tsx --import ./test/setup.ts --test src/categories/path.test.ts`
Expected: FAIL — `Cannot find module './path'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// backend/src/categories/path.ts
/**
 * Parse a category path string into trimmed segments.
 * `/` is the separator (so category names may not contain it).
 * Throws on any empty segment.
 */
export function parseCategoryPath(input: string): string[] {
  const segments = input.split('/').map((s) => s.trim());
  if (segments.length === 0 || segments.some((s) => s.length === 0)) {
    throw new Error('invalid category path');
  }
  return segments;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && yarn tsx --import ./test/setup.ts --test src/categories/path.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH \
git add backend/src/categories/path.ts backend/src/categories/path.test.ts && \
git commit -m "feat(categories): add parseCategoryPath"
```

---

### Task 5: `resolveCategoryPath` (concurrency-safe walk/create)

**Files:**
- Create: `backend/src/categories/resolvePath.ts`
- Test: `backend/src/categories/resolvePath.test.ts`

**Interfaces:**
- Consumes: `parseCategoryPath` (Task 4), `normalizeCategoryName` (Task 1), `Category` (Task 3).
- Produces: `resolveCategoryPath(householdId: number, input: string, opts?: { transaction?: import('sequelize').Transaction }): Promise<{ leafId: number; createdIds: number[] }>` — walks the path under the household, finding each segment by `(parentId, nameKey)` or creating it, returning the leaf id and the ids created during this call. Treats a unique-violation on create as "lost the race" and re-reads the existing sibling.

- [ ] **Step 1: Write the failing test**

```ts
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

test('matches existing siblings case-insensitively (no duplicate)', async () => {
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && yarn tsx --import ./test/setup.ts --test src/categories/resolvePath.test.ts`
Expected: FAIL — `Cannot find module './resolvePath'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// backend/src/categories/resolvePath.ts
import { UniqueConstraintError, type Transaction } from 'sequelize';
import { Category } from '../models';
import { sequelize } from '../db';
import { parseCategoryPath } from './path';
import { normalizeCategoryName } from './normalizeName';

export interface ResolvedPath {
  leafId: number;
  createdIds: number[];
}

async function findSibling(
  householdId: number,
  parentId: number | null,
  nameKey: string,
  transaction: Transaction,
): Promise<Category | null> {
  return Category.findOne({ where: { householdId, parentId, nameKey }, transaction });
}

export async function resolveCategoryPath(
  householdId: number,
  input: string,
  opts: { transaction?: Transaction } = {},
): Promise<ResolvedPath> {
  const segments = parseCategoryPath(input);

  const run = async (transaction: Transaction): Promise<ResolvedPath> => {
    let parentId: number | null = null;
    const createdIds: number[] = [];
    let leafId = 0;
    for (const segment of segments) {
      const nameKey = normalizeCategoryName(segment);
      let node = await findSibling(householdId, parentId, nameKey, transaction);
      if (!node) {
        try {
          node = await Category.create(
            { householdId, parentId, name: segment.trim(), icon: null },
            { transaction },
          );
          createdIds.push(node.id);
        } catch (err) {
          if (err instanceof UniqueConstraintError) {
            node = await findSibling(householdId, parentId, nameKey, transaction);
          }
          if (!node) throw err;
        }
      }
      parentId = node.id;
      leafId = node.id;
    }
    return { leafId, createdIds };
  };

  if (opts.transaction) return run(opts.transaction);
  return sequelize.transaction((t) => run(t));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && yarn tsx --import ./test/setup.ts --test src/categories/resolvePath.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH \
git add backend/src/categories/resolvePath.ts backend/src/categories/resolvePath.test.ts && \
git commit -m "feat(categories): add concurrency-safe resolveCategoryPath"
```

---

### Task 6: `wouldCreateCycle` (ancestor walk)

**Files:**
- Create: `backend/src/categories/cycle.ts`
- Test: `backend/src/categories/cycle.test.ts`

**Interfaces:**
- Consumes: `Category` (Task 3).
- Produces: `wouldCreateCycle(householdId: number, nodeId: number, newParentId: number): Promise<boolean>` — true if `newParentId` is `nodeId` itself or any descendant of `nodeId` (i.e. reparenting would form a loop).

- [ ] **Step 1: Write the failing test**

```ts
// backend/src/categories/cycle.test.ts
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { sequelize } from '../db';
import { Category, Household } from '../models';
import { wouldCreateCycle } from './cycle';

let householdId: number;
let work: Category, expenses: Category, internet: Category, home: Category;

beforeEach(async () => {
  await sequelize.sync({ force: true });
  householdId = (await Household.create({ name: 'T' })).id;
  work = await Category.create({ householdId, name: 'Work', icon: null, parentId: null });
  expenses = await Category.create({ householdId, name: 'Expenses', icon: null, parentId: work.id });
  internet = await Category.create({ householdId, name: 'Internet', icon: null, parentId: expenses.id });
  home = await Category.create({ householdId, name: 'Home', icon: null, parentId: null });
});

test('reparenting a node under itself is a cycle', async () => {
  assert.equal(await wouldCreateCycle(householdId, work.id, work.id), true);
});

test('reparenting a node under its own descendant is a cycle', async () => {
  assert.equal(await wouldCreateCycle(householdId, work.id, internet.id), true);
});

test('reparenting under an unrelated node is not a cycle', async () => {
  assert.equal(await wouldCreateCycle(householdId, expenses.id, home.id), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && yarn tsx --import ./test/setup.ts --test src/categories/cycle.test.ts`
Expected: FAIL — `Cannot find module './cycle'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// backend/src/categories/cycle.ts
import { Category } from '../models';

/**
 * True if moving `nodeId` under `newParentId` would create a loop —
 * i.e. newParentId is nodeId itself, or sits within nodeId's subtree.
 * Walks upward from newParentId to a root; if it meets nodeId, it's a cycle.
 */
export async function wouldCreateCycle(
  householdId: number,
  nodeId: number,
  newParentId: number,
): Promise<boolean> {
  let cursor: number | null = newParentId;
  while (cursor != null) {
    if (cursor === nodeId) return true;
    const parent: Category | null = await Category.findOne({
      where: { id: cursor, householdId },
      attributes: ['id', 'parentId'],
    });
    cursor = parent ? parent.parentId : null;
  }
  return false;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && yarn tsx --import ./test/setup.ts --test src/categories/cycle.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH \
git add backend/src/categories/cycle.ts backend/src/categories/cycle.test.ts && \
git commit -m "feat(categories): add wouldCreateCycle ancestor-walk guard"
```

---

### Task 7: `CategoryError` + `reparentCategory`

**Files:**
- Create: `backend/src/categories/errors.ts`
- Create: `backend/src/categories/reparent.ts`
- Test: `backend/src/categories/reparent.test.ts`

**Interfaces:**
- Consumes: `wouldCreateCycle` (Task 6), `normalizeCategoryName` (Task 1), `Category` (Task 3).
- Produces:
  - `class CategoryError extends Error { code: 'not_found' | 'cycle' | 'sibling_conflict' | 'has_children' | 'has_references'; constructor(code, message) }`
  - `reparentCategory(householdId: number, id: number, newParentId: number | null): Promise<Category>` — validates the node exists, that the move is not a cycle (when `newParentId` non-null), and that no existing sibling under the new parent shares the node's `nameKey`; then persists `parentId`. Throws `CategoryError` with the matching code.

- [ ] **Step 1: Write the failing test**

```ts
// backend/src/categories/reparent.test.ts
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { sequelize } from '../db';
import { Category, Household } from '../models';
import { reparentCategory } from './reparent';
import { CategoryError } from './errors';

let householdId: number;
let work: Category, expenses: Category, home: Category;

beforeEach(async () => {
  await sequelize.sync({ force: true });
  householdId = (await Household.create({ name: 'T' })).id;
  work = await Category.create({ householdId, name: 'Work', icon: null, parentId: null });
  expenses = await Category.create({ householdId, name: 'Expenses', icon: null, parentId: work.id });
  home = await Category.create({ householdId, name: 'Home', icon: null, parentId: null });
});

test('moves a node under a new parent', async () => {
  const moved = await reparentCategory(householdId, expenses.id, home.id);
  assert.equal(moved.parentId, home.id);
});

test('moving a node to root sets parentId null', async () => {
  const moved = await reparentCategory(householdId, expenses.id, null);
  assert.equal(moved.parentId, null);
});

test('rejects a cycle', async () => {
  await assert.rejects(
    () => reparentCategory(householdId, work.id, expenses.id),
    (e: unknown) => e instanceof CategoryError && e.code === 'cycle',
  );
});

test('rejects a sibling name collision under the new parent', async () => {
  // home already has a child "Expenses" (case variant) -> collision when moving work's Expenses under home
  await Category.create({ householdId, name: 'expenses', icon: null, parentId: home.id });
  await assert.rejects(
    () => reparentCategory(householdId, expenses.id, home.id),
    (e: unknown) => e instanceof CategoryError && e.code === 'sibling_conflict',
  );
});

test('rejects unknown node', async () => {
  await assert.rejects(
    () => reparentCategory(householdId, 999999, home.id),
    (e: unknown) => e instanceof CategoryError && e.code === 'not_found',
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && yarn tsx --import ./test/setup.ts --test src/categories/reparent.test.ts`
Expected: FAIL — `Cannot find module './reparent'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// backend/src/categories/errors.ts
export type CategoryErrorCode =
  | 'not_found'
  | 'cycle'
  | 'sibling_conflict'
  | 'has_children'
  | 'has_references';

export class CategoryError extends Error {
  code: CategoryErrorCode;
  constructor(code: CategoryErrorCode, message: string) {
    super(message);
    this.name = 'CategoryError';
    this.code = code;
  }
}
```

```ts
// backend/src/categories/reparent.ts
import { Op } from 'sequelize';
import { Category } from '../models';
import { wouldCreateCycle } from './cycle';
import { CategoryError } from './errors';

export async function reparentCategory(
  householdId: number,
  id: number,
  newParentId: number | null,
): Promise<Category> {
  const node = await Category.findOne({ where: { id, householdId } });
  if (!node) throw new CategoryError('not_found', `category ${id} not found`);

  if (newParentId != null) {
    const parent = await Category.findOne({ where: { id: newParentId, householdId } });
    if (!parent) throw new CategoryError('not_found', `parent ${newParentId} not found`);
    if (await wouldCreateCycle(householdId, id, newParentId)) {
      throw new CategoryError('cycle', 'cannot move a category into its own subtree');
    }
  }

  const conflict = await Category.findOne({
    where: {
      householdId,
      parentId: newParentId,
      nameKey: node.nameKey,
      id: { [Op.ne]: id },
    },
  });
  if (conflict) {
    throw new CategoryError(
      'sibling_conflict',
      `a sibling named "${node.name}" already exists under the target parent`,
    );
  }

  node.set('parentId', newParentId);
  await node.save();
  return node;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && yarn tsx --import ./test/setup.ts --test src/categories/reparent.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH \
git add backend/src/categories/errors.ts backend/src/categories/reparent.ts backend/src/categories/reparent.test.ts && \
git commit -m "feat(categories): add reparentCategory with cycle + sibling-conflict guards"
```

---

### Task 8: `deleteCategory` (block when node has children)

**Files:**
- Create: `backend/src/categories/deleteCategory.ts`
- Test: `backend/src/categories/deleteCategory.test.ts`

**Interfaces:**
- Consumes: `Category` (Task 3), `CategoryError` (Task 7).
- Produces: `deleteCategory(householdId: number, id: number): Promise<void>` — throws `CategoryError('not_found')` if missing, `CategoryError('has_children')` if any child category references it, otherwise deletes the row.
- Note: comprehensive reference-blocking across `Transaction`/`ExternalOrderItem`/`AiSuggestion`/`Rules`/`BudgetTarget` lands in **Plan B**, once those tables carry `categoryId` FKs. In Plan A nothing references a category by id, so child-blocking is the complete check.

- [ ] **Step 1: Write the failing test**

```ts
// backend/src/categories/deleteCategory.test.ts
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { sequelize } from '../db';
import { Category, Household } from '../models';
import { deleteCategory } from './deleteCategory';
import { CategoryError } from './errors';

let householdId: number;

beforeEach(async () => {
  await sequelize.sync({ force: true });
  householdId = (await Household.create({ name: 'T' })).id;
});

test('deletes a leaf node', async () => {
  const leaf = await Category.create({ householdId, name: 'Snacks', icon: null, parentId: null });
  await deleteCategory(householdId, leaf.id);
  assert.equal(await Category.findByPk(leaf.id), null);
});

test('blocks deleting a node that has children', async () => {
  const parent = await Category.create({ householdId, name: 'Groceries', icon: null, parentId: null });
  await Category.create({ householdId, name: 'Produce', icon: null, parentId: parent.id });
  await assert.rejects(
    () => deleteCategory(householdId, parent.id),
    (e: unknown) => e instanceof CategoryError && e.code === 'has_children',
  );
  assert.notEqual(await Category.findByPk(parent.id), null);
});

test('rejects unknown node', async () => {
  await assert.rejects(
    () => deleteCategory(householdId, 424242),
    (e: unknown) => e instanceof CategoryError && e.code === 'not_found',
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && yarn tsx --import ./test/setup.ts --test src/categories/deleteCategory.test.ts`
Expected: FAIL — `Cannot find module './deleteCategory'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// backend/src/categories/deleteCategory.ts
import { Category } from '../models';
import { CategoryError } from './errors';

export async function deleteCategory(householdId: number, id: number): Promise<void> {
  const node = await Category.findOne({ where: { id, householdId } });
  if (!node) throw new CategoryError('not_found', `category ${id} not found`);

  const childCount = await Category.count({ where: { householdId, parentId: id } });
  if (childCount > 0) {
    throw new CategoryError(
      'has_children',
      'reparent or remove child categories before deleting this one',
    );
  }

  await node.destroy();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && yarn tsx --import ./test/setup.ts --test src/categories/deleteCategory.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH \
git add backend/src/categories/deleteCategory.ts backend/src/categories/deleteCategory.test.ts && \
git commit -m "feat(categories): add deleteCategory blocking on children"
```

---

### Task 9: Routes — `/tree`, `/resolve-path`, create, reparent, delete

**Files:**
- Modify: `backend/src/routes/categories.ts`
- Test: `backend/test/integration/categoriesTree.test.ts`

**Interfaces:**
- Consumes: `resolveCategoryPath` (Task 5), `reparentCategory` (Task 7), `deleteCategory` (Task 8), `CategoryError` (Task 7), `Category` (Task 3), `householdWhere`.
- Produces HTTP endpoints (mounted at `/api/categories` via the existing `routeRegistry` entry — no registry change needed):
  - `GET /api/categories/tree` → `Array<{ id, name, parentId, icon, taxTreatment, children: [...] }>` (roots first, each with nested `children`).
  - `POST /api/categories/resolve-path` body `{ path: string }` → `{ id, name, path, createdIds: number[] }`.
  - `POST /api/categories` body `{ name: string, parentId?: number|null }` → created row (201).
  - `PATCH /api/categories/:id/reparent` body `{ parentId: number|null }` → updated row.
  - `DELETE /api/categories/:id` → 204, or 409 with `{ error, code }` when blocked.

- [ ] **Step 1: Write the failing test**

```ts
// backend/test/integration/categoriesTree.test.ts
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { setupPgTestDb, teardownPgTestDb, type PgTestDb } from './_setup/pgTestDb.js';

let app: import('express').Express;
let authed: ReturnType<typeof request.agent>;
let testDb: PgTestDb;

before(async () => {
  testDb = await setupPgTestDb('categories-tree');
  const mod = await import('../../src/app.js');
  app = mod.default;
  authed = request.agent(app);
  const register = await authed.post('/api/auth/register').send({
    email: 'cats@example.com',
    displayName: 'Cat User',
    password: 'password123',
  });
  assert.equal(register.status, 201);
});

after(async () => { await teardownPgTestDb(testDb); });

test('resolve-path creates a chain and tree reflects it', async () => {
  const resolved = await authed.post('/api/categories/resolve-path').send({ path: 'Work / Expenses / Internet' });
  assert.equal(resolved.status, 200);
  assert.equal(resolved.body.name, 'Internet');
  assert.equal(resolved.body.createdIds.length, 3);

  const tree = await authed.get('/api/categories/tree');
  assert.equal(tree.status, 200);
  const work = tree.body.find((n: { name: string }) => n.name === 'Work');
  assert.ok(work, 'Work root present');
  assert.equal(work.children[0].name, 'Expenses');
  assert.equal(work.children[0].children[0].name, 'Internet');
});

test('reparent moves a node; cycle is rejected', async () => {
  const home = await authed.post('/api/categories').send({ name: 'Home', parentId: null });
  assert.equal(home.status, 201);
  const tree = await authed.get('/api/categories/tree');
  const work = tree.body.find((n: { name: string }) => n.name === 'Work');
  const expenses = work.children[0];

  const moved = await authed.patch(`/api/categories/${expenses.id}/reparent`).send({ parentId: home.body.id });
  assert.equal(moved.status, 200);
  assert.equal(moved.body.parentId, home.body.id);

  const cycle = await authed.patch(`/api/categories/${home.body.id}/reparent`).send({ parentId: expenses.id });
  assert.equal(cycle.status, 409);
  assert.equal(cycle.body.code, 'cycle');
});

test('delete blocks a node with children, allows a leaf', async () => {
  const tree = await authed.get('/api/categories/tree');
  const home = tree.body.find((n: { name: string }) => n.name === 'Home');
  const blocked = await authed.delete(`/api/categories/${home.id}`);
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.code, 'has_children');

  const leaf = await authed.post('/api/categories').send({ name: 'Snacks', parentId: null });
  const ok = await authed.delete(`/api/categories/${leaf.body.id}`);
  assert.equal(ok.status, 204);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && TEST_DATABASE_URL=$TEST_DATABASE_URL yarn run test:integration --test-name-pattern 'resolve-path creates a chain'`
(or run the whole integration suite). Expected: FAIL — `/api/categories/tree` and `/resolve-path` 404, no such routes.
> Integration tests need Postgres; set `TEST_DATABASE_URL`. If running locally without it, the foundation service tests (Tasks 1–8) already cover the logic; this task's HTTP assertions require the PG job.

- [ ] **Step 3: Write minimal implementation**

Append to `backend/src/routes/categories.ts` (keep the existing `GET /` and `PATCH /:id` handlers; add imports + new routes before `export default router;`):

```ts
// add to imports at top:
import { resolveCategoryPath } from '../categories/resolvePath';
import { reparentCategory } from '../categories/reparent';
import { deleteCategory } from '../categories/deleteCategory';
import { CategoryError } from '../categories/errors';

type CategoryNode = {
  id: number;
  name: string;
  parentId: number | null;
  icon: string | null;
  taxTreatment: string;
  children: CategoryNode[];
};

function statusForCategoryError(code: CategoryError['code']): number {
  return code === 'not_found' ? 404 : 409;
}

router.get('/tree', async (req, res, next) => {
  try {
    const rows = await Category.findAll({ where: householdWhere(req), order: [['name', 'ASC']] });
    const byId = new Map<number, CategoryNode>();
    for (const r of rows) {
      byId.set(r.id, {
        id: r.id,
        name: r.name,
        parentId: r.parentId,
        icon: r.icon,
        taxTreatment: r.taxTreatment,
        children: [],
      });
    }
    const roots: CategoryNode[] = [];
    for (const node of byId.values()) {
      if (node.parentId != null && byId.has(node.parentId)) {
        byId.get(node.parentId)!.children.push(node);
      } else {
        roots.push(node);
      }
    }
    res.json(roots);
  } catch (e) {
    next(e);
  }
});

router.post('/resolve-path', async (req, res, next) => {
  try {
    const path = (req.body || {}).path;
    if (typeof path !== 'string' || path.trim().length === 0) {
      res.status(400).json({ error: 'path required' });
      return;
    }
    const { household } = (await import('../auth/middleware')).currentAuth(req);
    const { leafId, createdIds } = await resolveCategoryPath(household.id, path);
    const leaf = await Category.findByPk(leafId);
    res.json({ id: leafId, name: leaf?.name ?? null, path, createdIds });
  } catch (e) {
    if (e instanceof Error && e.message === 'invalid category path') {
      res.status(400).json({ error: e.message });
      return;
    }
    next(e);
  }
});

router.post('/', async (req, res, next) => {
  try {
    const b = (req.body || {}) as { name?: unknown; parentId?: unknown };
    if (typeof b.name !== 'string' || b.name.trim().length === 0) {
      res.status(400).json({ error: 'name required' });
      return;
    }
    const parentId = b.parentId == null ? null : Number(b.parentId);
    const { household } = (await import('../auth/middleware')).currentAuth(req);
    const row = await Category.create({
      householdId: household.id,
      name: b.name.trim(),
      parentId,
      icon: null,
    });
    res.status(201).json(row);
  } catch (e) {
    next(e);
  }
});

router.patch('/:id/reparent', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    const raw = (req.body || {}).parentId;
    const newParentId = raw == null ? null : Number(raw);
    const { household } = (await import('../auth/middleware')).currentAuth(req);
    const row = await reparentCategory(household.id, id, newParentId);
    res.json(row);
  } catch (e) {
    if (e instanceof CategoryError) {
      res.status(statusForCategoryError(e.code)).json({ error: e.message, code: e.code });
      return;
    }
    next(e);
  }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { household } = (await import('../auth/middleware')).currentAuth(req);
    await deleteCategory(household.id, id);
    res.status(204).end();
  } catch (e) {
    if (e instanceof CategoryError) {
      res.status(statusForCategoryError(e.code)).json({ error: e.message, code: e.code });
      return;
    }
    next(e);
  }
});
```

> The handlers use `currentAuth(req)` (from `backend/src/auth/middleware.ts`, same source `householdWhere` uses) to get `household.id` for service calls; this matches the household-scoped request context. Prefer a top-of-file `import { currentAuth } from '../auth/middleware';` over the inline dynamic import if the existing file style allows it — adjust to match the file's import block.

- [ ] **Step 4: Run the tests**

Run (with Postgres available): `cd backend && yarn run test:integration --test-name-pattern 'resolve-path|reparent|delete blocks'`
Expected: PASS (3 tests).
Then full typecheck + lint:
Run: `yarn workspace cashflow-backend run typecheck && yarn workspace cashflow-backend run lint`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH \
git add backend/src/routes/categories.ts backend/test/integration/categoriesTree.test.ts && \
git commit -m "feat(categories): tree/resolve-path/create/reparent/delete routes"
```

---

## Final verification

- [ ] Run the full backend unit suite: `yarn workspace cashflow-backend run test` — all green.
- [ ] Run typecheck + lint: `yarn workspace cashflow-backend run typecheck && yarn workspace cashflow-backend run lint`.
- [ ] Apply the migration against a scratch DB: `yarn db:migrate` then `yarn workspace cashflow-backend run db:migrate:undo` to confirm up/down both run clean.

## What Plan A deliberately leaves to Plan B / C

- **Plan B:** add `categoryId` FK columns to `Transaction` / `ExternalOrderItem` / `AiSuggestion` / Rules / `BudgetTarget` + backfill; `syncCategoryLeafNameMirrors`; **name rename** route (with mirror fan-out); extend `deleteCategory` to block on those references; shared rollup utility wired into `aggregateMonthly` / `aggregateSankey` / `aggregateDashboard` / budgets / insights; move write paths to ids.
- **Plan C:** picker path-syntax entry + full-path suggestion display; category manager page (drag-reparent with the two distinct error messages, delete-block messaging); AI full-path hints + deferred (accept-time) resolution.
