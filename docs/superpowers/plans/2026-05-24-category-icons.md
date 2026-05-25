# Category Icons Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Promote categories to a first-class entity with a per-household icon (lucide-react), exposed in Settings → Categories and rendered beside category text in Budgets, Transactions, Review Inbox, and Dashboard.

**Architecture:**
- New `Category` Sequelize model (`id`, `household_id`, `name` unique-per-household, `icon` nullable). Transactions / rules / budgets keep storing the category as a free-text string; whenever one is written, a hook `ensureCategory` upserts the row. A migration backfills the table from existing data.
- New REST surface `GET /api/categories` and `PATCH /api/categories/:id` (icon only). Icon name validated against a shared allowlist (`CATEGORY_ICON_NAMES`) so the bundle imports a curated subset of lucide-react rather than the full 1500-icon library.
- Frontend: new `<CategoryIcon name="...">` component reads the cached `/api/categories` list via a `useCategories` hook and resolves to the lucide component, falling back to `<Tag>`. New `Settings → Categories` tab edits the icon via `<CategoryIconPicker>`. The icon is rendered beside category labels in BudgetsTab, TransactionsPage row, ReviewInboxPage selected row + `CategoryCloudPicker` chips, and DashboardPage category lists.

**Tech Stack:** Sequelize (sqlite dev / Postgres prod), Express, React 19 + Vite, lucide-react 1.14.x, `node:test` (backend), Vitest + Testing Library (frontend).

---

## File Structure

**Backend — created:**
- `backend/src/models/Category.ts` — Sequelize model
- `backend/src/migrations/20260524170001-categories.js` — create table + unique index
- `backend/src/migrations/20260524170002-backfill-categories.js` — seed from existing transactions/rules/budgets
- `backend/src/lib/ensureCategory.ts` — `ensureCategory(householdId, name)` upsert helper
- `backend/src/routes/categories.ts` — `GET /` and `PATCH /:id`
- `backend/test/ensureCategory.test.ts`
- `backend/test/categoriesRoute.test.ts`

**Backend — modified:**
- `backend/src/models/index.ts` — `initCategory(sequelize)` + `Household.hasMany(Category)`
- `backend/src/models/Transaction.ts` — `afterSave` hook → `ensureCategory`
- `backend/src/models/Rule.ts` — `afterSave` hook → `ensureCategory`
- `backend/src/models/BudgetTarget.ts` — `afterSave` hook → `ensureCategory`
- `backend/src/app.ts` — mount `/api/categories` router

**Shared — created:**
- `shared/categoryIcons.ts` — `CATEGORY_ICON_NAMES` whitelist (string literals only — frontend resolves to lucide components)

**Shared — modified:**
- `shared/api-types.ts` — add `Category` type

**Frontend — created:**
- `frontend/src/types/api.ts` (or extend existing) — `Category` re-export if needed
- `frontend/src/lib/useCategories.ts` — fetch + cache `/api/categories`
- `frontend/src/components/CategoryIcon.tsx` — name → lucide icon component
- `frontend/src/components/CategoryIcon.test.tsx`
- `frontend/src/components/CategoryIconPicker.tsx` — grid picker dialog body
- `frontend/src/pages/settings/tabs/CategoriesTab.tsx`
- `frontend/src/pages/settings/tabs/CategoriesTab.test.tsx`

**Frontend — modified:**
- `frontend/src/App.tsx` — `<Route path="categories" element={<CategoriesTab />} />`
- `frontend/src/pages/settings/SettingsPage.tsx` — add `'categories'` tab
- `frontend/src/pages/settings/useActiveSettingsTopTab.ts` — extend union type
- `frontend/src/pages/settings/tabs/BudgetsTab.tsx` — render `<CategoryIcon>` beside `{budget.category ?? 'Overall'}`
- `frontend/src/pages/TransactionsPage.tsx` — render icon in category cell
- `frontend/src/pages/ReviewInboxPage.tsx` — render icon beside chosen category label
- `frontend/src/components/CategoryCloudPicker.tsx` — accept optional icon-rendering hook so options can show icons
- `frontend/src/pages/DashboardPage.tsx` — render icon in category breakdown list (skip chart axis ticks)

---

## Task 1: Shared icon whitelist

**Files:**
- Create: `shared/categoryIcons.ts`

- [ ] **Step 1: Create the whitelist**

```ts
// shared/categoryIcons.ts
//
// Names MUST exactly match lucide-react exports. Keep this list curated —
// every name listed here is imported into the frontend bundle.

export const CATEGORY_ICON_NAMES = [
  'ShoppingCart',
  'ShoppingBag',
  'Utensils',
  'Coffee',
  'Pizza',
  'Beer',
  'Wine',
  'Home',
  'Bed',
  'Sofa',
  'Lightbulb',
  'Plug',
  'Wifi',
  'Phone',
  'Smartphone',
  'Tv',
  'Laptop',
  'Car',
  'Fuel',
  'Bus',
  'Train',
  'Plane',
  'Bike',
  'ParkingSquare',
  'Stethoscope',
  'Pill',
  'HeartPulse',
  'Dumbbell',
  'GraduationCap',
  'BookOpen',
  'Briefcase',
  'Building2',
  'PiggyBank',
  'Landmark',
  'CreditCard',
  'Banknote',
  'Wallet',
  'Receipt',
  'Gift',
  'PartyPopper',
  'Cake',
  'Baby',
  'PawPrint',
  'Flower2',
  'Trees',
  'Wrench',
  'Hammer',
  'Paintbrush',
  'Scissors',
  'Shirt',
  'Gem',
  'Camera',
  'Music',
  'Film',
  'Gamepad2',
  'Ticket',
  'Map',
  'Mountain',
  'Sun',
  'Cloud',
  'Umbrella',
  'Snowflake',
  'Flame',
  'Droplet',
  'Trash2',
  'Recycle',
  'Leaf',
  'Heart',
  'Star',
  'Sparkles',
  'Tag',
  'Bookmark',
  'Folder',
  'Box',
  'Package',
  'Truck',
  'HandCoins',
  'TrendingUp',
  'TrendingDown',
] as const

export type CategoryIconName = (typeof CATEGORY_ICON_NAMES)[number]

export function isCategoryIconName(value: unknown): value is CategoryIconName {
  return (
    typeof value === 'string' &&
    (CATEGORY_ICON_NAMES as readonly string[]).includes(value)
  )
}
```

- [ ] **Step 2: Commit**

```bash
git add shared/categoryIcons.ts
git commit -m "feat(categories): add CATEGORY_ICON_NAMES whitelist"
```

---

## Task 2: Category Sequelize model

**Files:**
- Create: `backend/src/models/Category.ts`
- Modify: `backend/src/models/index.ts`

- [ ] **Step 1: Write the model**

```ts
// backend/src/models/Category.ts
import {
  Model,
  DataTypes,
  type Sequelize,
  type ModelAttributes,
  InferAttributes,
  InferCreationAttributes,
  CreationOptional,
} from 'sequelize';

export class Category extends Model<
  InferAttributes<Category>,
  InferCreationAttributes<Category>
> {
  declare id: CreationOptional<number>;
  declare householdId: number;
  declare name: string;
  declare icon: string | null;
  declare readonly createdAt: CreationOptional<Date>;
  declare readonly updatedAt: CreationOptional<Date>;
}

export function initCategory(sequelize: Sequelize): typeof Category {
  Category.init(
    {
      id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
      householdId: {
        type: DataTypes.INTEGER,
        field: 'household_id',
        allowNull: false,
      },
      name: { type: DataTypes.STRING(128), allowNull: false },
      icon: { type: DataTypes.STRING(64), allowNull: true },
    } as ModelAttributes<Category>,
    {
      sequelize,
      modelName: 'Category',
      tableName: 'categories',
      underscored: true,
      timestamps: true,
      indexes: [{ unique: true, fields: ['household_id', 'name'] }],
    }
  );
  return Category;
}
```

- [ ] **Step 2: Register in models/index.ts**

Add to imports block (matching existing order):

```ts
import { Category, initCategory } from './Category';
```

Add to init block (after `initContact(sequelize);`):

```ts
initCategory(sequelize);
```

Add to associations block (search for `Household.hasMany(Contact` and add nearby):

```ts
Household.hasMany(Category, { foreignKey: 'household_id', as: 'categories' });
Category.belongsTo(Household, { foreignKey: 'household_id', as: 'household' });
```

Add `Category` to the `export` list at the bottom of `models/index.ts` (follow the existing pattern; the file re-exports every model).

- [ ] **Step 3: Verify typecheck passes**

```bash
cd backend && yarn typecheck
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add backend/src/models/Category.ts backend/src/models/index.ts
git commit -m "feat(categories): add Category Sequelize model"
```

---

## Task 3: Migration — create categories table

**Files:**
- Create: `backend/src/migrations/20260524170001-categories.js`

- [ ] **Step 1: Write the migration**

```js
'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('categories', {
      id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
      household_id: { type: Sequelize.INTEGER, allowNull: false },
      name: { type: Sequelize.STRING(128), allowNull: false },
      icon: { type: Sequelize.STRING(64), allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.addIndex('categories', ['household_id', 'name'], {
      unique: true,
      name: 'categories_household_name_unique',
    });
  },
  async down(queryInterface) {
    await queryInterface.dropTable('categories');
  },
};
```

- [ ] **Step 2: Run the migration locally (sqlite)**

```bash
cd backend && yarn db:migrate
```

Expected: `== 20260524170001-categories: migrated`.

- [ ] **Step 3: Commit**

```bash
git add backend/src/migrations/20260524170001-categories.js
git commit -m "feat(categories): create categories table"
```

---

## Task 4: Migration — backfill from existing data

**Files:**
- Create: `backend/src/migrations/20260524170002-backfill-categories.js`

- [ ] **Step 1: Write the backfill migration**

```js
'use strict';

// Backfill categories from every existing distinct (household_id, category) seen
// in transactions.final_category, rules.category, and budget_targets.category.
// `icon` is left NULL — users will assign icons via Settings → Categories.
//
// Uses INSERT ... SELECT with NOT EXISTS so we never violate the unique
// (household_id, name) index, even if the same value appears in two source
// tables. Works against both sqlite and postgres.

module.exports = {
  async up(queryInterface) {
    const sql = `
      INSERT INTO categories (household_id, name, icon, created_at, updated_at)
      SELECT DISTINCT src.household_id, TRIM(src.category) AS name, NULL,
             CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      FROM (
        SELECT household_id, final_category AS category FROM transactions
         WHERE final_category IS NOT NULL AND TRIM(final_category) <> ''
        UNION
        SELECT household_id, category FROM rules
         WHERE category IS NOT NULL AND TRIM(category) <> ''
        UNION
        SELECT household_id, category FROM budget_targets
         WHERE category IS NOT NULL AND TRIM(category) <> ''
      ) AS src
      WHERE NOT EXISTS (
        SELECT 1 FROM categories c
        WHERE c.household_id = src.household_id
          AND c.name = TRIM(src.category)
      );
    `;
    await queryInterface.sequelize.query(sql);
  },
  async down() {
    // Non-destructive on rollback — categories backfilled here may have icons
    // assigned afterwards. Use the previous migration's down() to drop the table.
  },
};
```

- [ ] **Step 2: Run migration**

```bash
cd backend && yarn db:migrate
```

Expected: `== 20260524170002-backfill-categories: migrated`.

- [ ] **Step 3: Verify rows backfilled (sqlite)**

```bash
cd backend && sqlite3 data/cashflow.sqlite "SELECT household_id, name, icon FROM categories LIMIT 20;"
```

Expected: one row per distinct (household, category) seen in source tables.

- [ ] **Step 4: Commit**

```bash
git add backend/src/migrations/20260524170002-backfill-categories.js
git commit -m "feat(categories): backfill categories from existing tx/rules/budgets"
```

---

## Task 5: `ensureCategory` helper

**Files:**
- Create: `backend/src/lib/ensureCategory.ts`
- Test: `backend/test/ensureCategory.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// backend/test/ensureCategory.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sequelize } from '../src/db';
import '../src/models';
import { Category } from '../src/models/Category';
import { Household } from '../src/models/Household';
import { ensureCategory } from '../src/lib/ensureCategory';

test('ensureCategory: inserts new (household, name) row', async () => {
  await sequelize.sync({ force: true });
  const hh = await Household.create({ name: 'H' });
  await ensureCategory(hh.id, 'Groceries');
  const rows = await Category.findAll({ where: { householdId: hh.id } });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, 'Groceries');
  assert.equal(rows[0].icon, null);
});

test('ensureCategory: trims and deduplicates', async () => {
  await sequelize.sync({ force: true });
  const hh = await Household.create({ name: 'H' });
  await ensureCategory(hh.id, '  Rent ');
  await ensureCategory(hh.id, 'Rent');
  const rows = await Category.findAll({ where: { householdId: hh.id } });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, 'Rent');
});

test('ensureCategory: ignores null/empty/whitespace', async () => {
  await sequelize.sync({ force: true });
  const hh = await Household.create({ name: 'H' });
  await ensureCategory(hh.id, null);
  await ensureCategory(hh.id, '');
  await ensureCategory(hh.id, '   ');
  const rows = await Category.findAll({ where: { householdId: hh.id } });
  assert.equal(rows.length, 0);
});

test('ensureCategory: preserves existing icon on re-upsert', async () => {
  await sequelize.sync({ force: true });
  const hh = await Household.create({ name: 'H' });
  await ensureCategory(hh.id, 'Coffee');
  const row = await Category.findOne({ where: { householdId: hh.id, name: 'Coffee' } });
  if (!row) throw new Error('row missing');
  row.set('icon', 'Coffee');
  await row.save();
  await ensureCategory(hh.id, 'Coffee');
  const after = await Category.findOne({ where: { householdId: hh.id, name: 'Coffee' } });
  assert.equal(after?.icon, 'Coffee');
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd backend && npx tsx --test test/ensureCategory.test.ts
```

Expected: FAIL with "Cannot find module '../src/lib/ensureCategory'".

- [ ] **Step 3: Write the implementation**

```ts
// backend/src/lib/ensureCategory.ts
import { Category } from '../models/Category';

/**
 * Upsert a (householdId, name) row in `categories`. No-op for null / empty /
 * whitespace-only names. Never overwrites an existing `icon` value.
 */
export async function ensureCategory(
  householdId: number,
  name: string | null | undefined
): Promise<void> {
  if (name == null) return;
  const trimmed = name.trim();
  if (!trimmed) return;
  await Category.findOrCreate({
    where: { householdId, name: trimmed },
    defaults: { householdId, name: trimmed, icon: null },
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd backend && npx tsx --test test/ensureCategory.test.ts
```

Expected: 4 passing.

- [ ] **Step 5: Commit**

```bash
git add backend/src/lib/ensureCategory.ts backend/test/ensureCategory.test.ts
git commit -m "feat(categories): add ensureCategory upsert helper"
```

---

## Task 6: Sequelize hooks — auto-upsert on write

**Files:**
- Modify: `backend/src/models/Transaction.ts`
- Modify: `backend/src/models/Rule.ts`
- Modify: `backend/src/models/BudgetTarget.ts`
- Test: `backend/test/ensureCategoryHooks.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// backend/test/ensureCategoryHooks.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sequelize } from '../src/db';
import '../src/models';
import { Category } from '../src/models/Category';
import { Transaction } from '../src/models/Transaction';
import { Rule } from '../src/models/Rule';
import { BudgetTarget } from '../src/models/BudgetTarget';
import { Household } from '../src/models/Household';
import { Account } from '../src/models/Account';

async function makeHousehold(): Promise<Household> {
  await sequelize.sync({ force: true });
  return Household.create({ name: 'H' });
}

test('Transaction afterSave: ensures category for finalCategory', async () => {
  const hh = await makeHousehold();
  const acct = await Account.create({
    householdId: hh.id, name: 'X', currency: 'CAD', kind: 'chequing',
  } as any);
  await Transaction.create({
    householdId: hh.id, accountId: acct.id, date: '2026-01-01',
    amount: '10.00', currency: 'CAD', description: 'd', finalCategory: 'Coffee',
  } as any);
  const rows = await Category.findAll({ where: { householdId: hh.id } });
  assert.deepEqual(rows.map((r) => r.name), ['Coffee']);
});

test('Rule afterSave: ensures category', async () => {
  const hh = await makeHousehold();
  await Rule.create({
    householdId: hh.id, pattern: 'foo', category: 'Subscriptions',
  } as any);
  const rows = await Category.findAll({ where: { householdId: hh.id } });
  assert.deepEqual(rows.map((r) => r.name), ['Subscriptions']);
});

test('BudgetTarget afterSave: ensures category', async () => {
  const hh = await makeHousehold();
  await BudgetTarget.create({
    householdId: hh.id, category: 'Rent', currency: 'CAD', amount: '1200',
  } as any);
  const rows = await Category.findAll({ where: { householdId: hh.id } });
  assert.deepEqual(rows.map((r) => r.name), ['Rent']);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd backend && npx tsx --test test/ensureCategoryHooks.test.ts
```

Expected: FAIL — no Category rows created.

- [ ] **Step 3: Wire hooks in each model's `init*` function**

In `backend/src/models/Transaction.ts`, append to the body of `initTransaction` (after `Transaction.init({...})`, before `return Transaction;`):

```ts
Transaction.addHook('afterSave', async (instance: Transaction) => {
  const { ensureCategory } = await import('../lib/ensureCategory');
  await ensureCategory(instance.householdId, instance.finalCategory);
});
```

In `backend/src/models/Rule.ts`, append to the body of `initRule`:

```ts
Rule.addHook('afterSave', async (instance: Rule) => {
  const { ensureCategory } = await import('../lib/ensureCategory');
  await ensureCategory(instance.householdId, instance.category);
});
```

In `backend/src/models/BudgetTarget.ts`, append to the body of `initBudgetTarget`:

```ts
BudgetTarget.addHook('afterSave', async (instance: BudgetTarget) => {
  const { ensureCategory } = await import('../lib/ensureCategory');
  await ensureCategory(instance.householdId, instance.category);
});
```

Dynamic import avoids a model ↔ helper circular import at module-load time.

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd backend && npx tsx --test test/ensureCategoryHooks.test.ts
```

Expected: 3 passing.

- [ ] **Step 5: Run full backend test suite (regression check)**

```bash
cd backend && yarn test
```

Expected: all green. Hooks should be no-ops when `category` is null.

- [ ] **Step 6: Commit**

```bash
git add backend/src/models/Transaction.ts backend/src/models/Rule.ts backend/src/models/BudgetTarget.ts backend/test/ensureCategoryHooks.test.ts
git commit -m "feat(categories): auto-upsert Category on tx/rule/budget save"
```

---

## Task 7: GET /api/categories + PATCH /api/categories/:id

**Files:**
- Create: `backend/src/routes/categories.ts`
- Modify: `backend/src/app.ts`
- Test: `backend/test/categoriesRoute.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// backend/test/categoriesRoute.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { sequelize } from '../src/db';
import '../src/models';
import { app } from '../src/app';
import { Category } from '../src/models/Category';
import { Household } from '../src/models/Household';
import { User } from '../src/models/User';
import { Session } from '../src/models/Session';

async function authCookie(): Promise<{ cookie: string; householdId: number }> {
  await sequelize.sync({ force: true });
  const hh = await Household.create({ name: 'H' });
  const user = await User.create({
    email: 'a@b.c', passwordHash: 'x', householdId: hh.id,
  } as any);
  const session = await Session.create({ userId: user.id, token: 'tok' } as any);
  return { cookie: `session=${session.token}`, householdId: hh.id };
}

test('GET /api/categories returns household categories', async () => {
  const { cookie, householdId } = await authCookie();
  await Category.bulkCreate([
    { householdId, name: 'Coffee', icon: 'Coffee' },
    { householdId, name: 'Rent', icon: null },
  ]);
  const res = await request(app).get('/api/categories').set('Cookie', cookie);
  assert.equal(res.status, 200);
  assert.deepEqual(
    res.body.map((r: any) => ({ name: r.name, icon: r.icon })),
    [{ name: 'Coffee', icon: 'Coffee' }, { name: 'Rent', icon: null }]
  );
});

test('PATCH /api/categories/:id updates icon', async () => {
  const { cookie, householdId } = await authCookie();
  const row = await Category.create({ householdId, name: 'Rent', icon: null });
  const res = await request(app)
    .patch(`/api/categories/${row.id}`)
    .set('Cookie', cookie)
    .send({ icon: 'Home' });
  assert.equal(res.status, 200);
  assert.equal(res.body.icon, 'Home');
});

test('PATCH /api/categories/:id rejects unknown icon name', async () => {
  const { cookie, householdId } = await authCookie();
  const row = await Category.create({ householdId, name: 'Rent', icon: null });
  const res = await request(app)
    .patch(`/api/categories/${row.id}`)
    .set('Cookie', cookie)
    .send({ icon: 'NotARealIcon' });
  assert.equal(res.status, 400);
});

test('PATCH /api/categories/:id accepts null to clear icon', async () => {
  const { cookie, householdId } = await authCookie();
  const row = await Category.create({ householdId, name: 'Rent', icon: 'Home' });
  const res = await request(app)
    .patch(`/api/categories/${row.id}`)
    .set('Cookie', cookie)
    .send({ icon: null });
  assert.equal(res.status, 200);
  assert.equal(res.body.icon, null);
});

test('PATCH /api/categories/:id 404 for other household', async () => {
  const { cookie } = await authCookie();
  const otherHh = await Household.create({ name: 'Other' });
  const row = await Category.create({ householdId: otherHh.id, name: 'X', icon: null });
  const res = await request(app)
    .patch(`/api/categories/${row.id}`)
    .set('Cookie', cookie)
    .send({ icon: 'Home' });
  assert.equal(res.status, 404);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd backend && npx tsx --test test/categoriesRoute.test.ts
```

Expected: FAIL — route returns 404 because it's not mounted.

- [ ] **Step 3: Implement the route**

```ts
// backend/src/routes/categories.ts
import { Router } from 'express';
import { Category } from '../models';
import { householdWhere } from '../auth/scope';
import { isCategoryIconName } from '@cashflow/shared/categoryIcons';

const router = Router();

router.get('/', async (req, res, next) => {
  try {
    const rows = await Category.findAll({
      where: householdWhere(req),
      order: [['name', 'ASC']],
    });
    res.json(rows);
  } catch (e) {
    next(e);
  }
});

router.patch('/:id', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    const row = await Category.findOne({ where: { id, ...householdWhere(req) } });
    if (!row) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    const b = (req.body || {}) as Record<string, unknown>;
    if (!('icon' in b)) {
      res.status(400).json({ error: 'icon field required' });
      return;
    }
    if (b.icon === null) {
      row.set('icon', null);
    } else if (typeof b.icon === 'string' && isCategoryIconName(b.icon)) {
      row.set('icon', b.icon);
    } else {
      res.status(400).json({ error: 'unknown icon name' });
      return;
    }
    await row.save();
    res.json(row);
  } catch (e) {
    next(e);
  }
});

export default router;
```

- [ ] **Step 4: Mount in app.ts**

In `backend/src/app.ts`, add to imports near other route imports:

```ts
import categoriesRouter from './routes/categories';
```

Add to the `app.use('/api', requireAuth)` block (after `app.use('/api/contacts', ...)`):

```ts
app.use('/api/categories', categoriesRouter);
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
cd backend && npx tsx --test test/categoriesRoute.test.ts
```

Expected: 5 passing.

- [ ] **Step 6: Add Category to shared/api-types.ts**

Append to `shared/api-types.ts`:

```ts
export type Category = {
  id: number
  householdId: number
  name: string
  icon: string | null
  createdAt: string
  updatedAt: string
}
```

- [ ] **Step 7: Commit**

```bash
git add backend/src/routes/categories.ts backend/src/app.ts backend/test/categoriesRoute.test.ts shared/api-types.ts
git commit -m "feat(categories): GET/PATCH /api/categories with icon validation"
```

---

## Task 8: Frontend `useCategories` hook

**Files:**
- Create: `frontend/src/lib/useCategories.ts`
- Test: `frontend/src/lib/useCategories.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// frontend/src/lib/useCategories.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor, act } from '@testing-library/react'
import { useCategories, _resetCategoriesCacheForTest } from './useCategories'
import * as api from './api'

describe('useCategories', () => {
  beforeEach(() => {
    _resetCategoriesCacheForTest()
    vi.restoreAllMocks()
  })

  it('fetches once and shares the result across hook instances', async () => {
    const spy = vi.spyOn(api, 'getJson').mockResolvedValue([
      { id: 1, householdId: 1, name: 'Coffee', icon: 'Coffee',
        createdAt: '', updatedAt: '' },
    ])
    const a = renderHook(() => useCategories())
    const b = renderHook(() => useCategories())
    await waitFor(() => expect(a.result.current.categories.length).toBe(1))
    await waitFor(() => expect(b.result.current.categories.length).toBe(1))
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('exposes a refresh() that re-fetches', async () => {
    const spy = vi.spyOn(api, 'getJson').mockResolvedValue([])
    const { result } = renderHook(() => useCategories())
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1))
    await act(async () => { await result.current.refresh() })
    expect(spy).toHaveBeenCalledTimes(2)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd frontend && yarn test src/lib/useCategories.test.tsx
```

Expected: FAIL — `useCategories` not defined.

- [ ] **Step 3: Implement the hook**

```ts
// frontend/src/lib/useCategories.ts
import { useEffect, useState, useCallback } from 'react'
import { getJson } from './api'
import type { Category } from '../types/api'

type Listener = (cats: Category[]) => void

let cache: Category[] | null = null
let inflight: Promise<Category[]> | null = null
const listeners = new Set<Listener>()

export function _resetCategoriesCacheForTest(): void {
  cache = null
  inflight = null
  listeners.clear()
}

async function load(force = false): Promise<Category[]> {
  if (!force && cache) return cache
  if (!force && inflight) return inflight
  inflight = getJson<Category[]>('/api/categories').then((rows) => {
    cache = rows
    inflight = null
    for (const l of listeners) l(rows)
    return rows
  })
  return inflight
}

export function useCategories(): {
  categories: Category[]
  refresh: () => Promise<void>
  byName: (name: string | null | undefined) => Category | undefined
} {
  const [categories, setCategories] = useState<Category[]>(cache ?? [])

  useEffect(() => {
    listeners.add(setCategories)
    void load().then(setCategories)
    return () => { listeners.delete(setCategories) }
  }, [])

  const refresh = useCallback(async () => {
    const next = await load(true)
    setCategories(next)
  }, [])

  const byName = useCallback(
    (name: string | null | undefined) =>
      name ? categories.find((c) => c.name === name) : undefined,
    [categories]
  )

  return { categories, refresh, byName }
}
```

You may also need to add `Category` to `frontend/src/types/api.ts` (re-export from `@cashflow/shared` or duplicate the type — match what the file already does for other types).

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd frontend && yarn test src/lib/useCategories.test.tsx
```

Expected: 2 passing.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/useCategories.ts frontend/src/lib/useCategories.test.tsx frontend/src/types/api.ts
git commit -m "feat(categories): useCategories hook with shared cache"
```

---

## Task 9: `<CategoryIcon>` component

**Files:**
- Create: `frontend/src/components/CategoryIcon.tsx`
- Test: `frontend/src/components/CategoryIcon.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// frontend/src/components/CategoryIcon.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, waitFor } from '@testing-library/react'
import { CategoryIcon } from './CategoryIcon'
import * as api from '../lib/api'
import { _resetCategoriesCacheForTest } from '../lib/useCategories'

describe('CategoryIcon', () => {
  beforeEach(() => {
    _resetCategoriesCacheForTest()
    vi.restoreAllMocks()
  })

  it('renders the lucide icon mapped to the category', async () => {
    vi.spyOn(api, 'getJson').mockResolvedValue([
      { id: 1, householdId: 1, name: 'Coffee', icon: 'Coffee',
        createdAt: '', updatedAt: '' },
    ])
    const { container } = render(<CategoryIcon name="Coffee" />)
    await waitFor(() => {
      expect(container.querySelector('[data-icon="Coffee"]')).toBeInTheDocument()
    })
  })

  it('renders fallback Tag icon for unknown category', async () => {
    vi.spyOn(api, 'getJson').mockResolvedValue([])
    const { container } = render(<CategoryIcon name="Unknown" />)
    await waitFor(() => {
      expect(container.querySelector('[data-icon="Tag"]')).toBeInTheDocument()
    })
  })

  it('renders nothing when name is null', () => {
    const { container } = render(<CategoryIcon name={null} />)
    expect(container).toBeEmptyDOMElement()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd frontend && yarn test src/components/CategoryIcon.test.tsx
```

Expected: FAIL — component not defined.

- [ ] **Step 3: Implement the component**

```tsx
// frontend/src/components/CategoryIcon.tsx
import {
  ShoppingCart, ShoppingBag, Utensils, Coffee, Pizza, Beer, Wine,
  Home, Bed, Sofa, Lightbulb, Plug, Wifi, Phone, Smartphone, Tv, Laptop,
  Car, Fuel, Bus, Train, Plane, Bike, ParkingSquare,
  Stethoscope, Pill, HeartPulse, Dumbbell,
  GraduationCap, BookOpen, Briefcase, Building2,
  PiggyBank, Landmark, CreditCard, Banknote, Wallet, Receipt,
  Gift, PartyPopper, Cake, Baby, PawPrint, Flower2, Trees,
  Wrench, Hammer, Paintbrush, Scissors, Shirt, Gem,
  Camera, Music, Film, Gamepad2, Ticket,
  Map, Mountain, Sun, Cloud, Umbrella, Snowflake, Flame, Droplet,
  Trash2, Recycle, Leaf, Heart, Star, Sparkles,
  Tag, Bookmark, Folder, Box, Package, Truck,
  HandCoins, TrendingUp, TrendingDown,
  type LucideIcon,
} from 'lucide-react'
import type { CategoryIconName } from '@cashflow/shared/categoryIcons'
import { useCategories } from '../lib/useCategories'

export const CATEGORY_ICON_COMPONENTS: Record<CategoryIconName, LucideIcon> = {
  ShoppingCart, ShoppingBag, Utensils, Coffee, Pizza, Beer, Wine,
  Home, Bed, Sofa, Lightbulb, Plug, Wifi, Phone, Smartphone, Tv, Laptop,
  Car, Fuel, Bus, Train, Plane, Bike, ParkingSquare,
  Stethoscope, Pill, HeartPulse, Dumbbell,
  GraduationCap, BookOpen, Briefcase, Building2,
  PiggyBank, Landmark, CreditCard, Banknote, Wallet, Receipt,
  Gift, PartyPopper, Cake, Baby, PawPrint, Flower2, Trees,
  Wrench, Hammer, Paintbrush, Scissors, Shirt, Gem,
  Camera, Music, Film, Gamepad2, Ticket,
  Map, Mountain, Sun, Cloud, Umbrella, Snowflake, Flame, Droplet,
  Trash2, Recycle, Leaf, Heart, Star, Sparkles,
  Tag, Bookmark, Folder, Box, Package, Truck,
  HandCoins, TrendingUp, TrendingDown,
}

type Props = {
  name: string | null | undefined
  size?: number
  className?: string
}

export function CategoryIcon({ name, size = 16, className }: Props) {
  const { byName } = useCategories()
  if (!name) return null
  const cat = byName(name)
  const iconName = cat?.icon as CategoryIconName | null | undefined
  const Icon = iconName ? CATEGORY_ICON_COMPONENTS[iconName] : Tag
  return <Icon size={size} className={className} data-icon={iconName ?? 'Tag'} />
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd frontend && yarn test src/components/CategoryIcon.test.tsx
```

Expected: 3 passing.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/CategoryIcon.tsx frontend/src/components/CategoryIcon.test.tsx
git commit -m "feat(categories): CategoryIcon component with lucide map"
```

---

## Task 10: `<CategoryIconPicker>` dialog body

**Files:**
- Create: `frontend/src/components/CategoryIconPicker.tsx`
- Test: `frontend/src/components/CategoryIconPicker.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// frontend/src/components/CategoryIconPicker.test.tsx
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { CategoryIconPicker } from './CategoryIconPicker'

describe('CategoryIconPicker', () => {
  it('renders a button per icon and fires onSelect', async () => {
    const onSelect = vi.fn()
    render(<CategoryIconPicker value={null} onSelect={onSelect} />)
    const coffeeButton = screen.getByRole('button', { name: /Coffee/i })
    await userEvent.click(coffeeButton)
    expect(onSelect).toHaveBeenCalledWith('Coffee')
  })

  it('renders a "None" choice that emits null', async () => {
    const onSelect = vi.fn()
    render(<CategoryIconPicker value="Coffee" onSelect={onSelect} />)
    await userEvent.click(screen.getByRole('button', { name: /none/i }))
    expect(onSelect).toHaveBeenCalledWith(null)
  })

  it('marks the current value as selected', () => {
    render(<CategoryIconPicker value="Coffee" onSelect={() => {}} />)
    expect(
      screen.getByRole('button', { name: /Coffee/i })
    ).toHaveAttribute('aria-pressed', 'true')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd frontend && yarn test src/components/CategoryIconPicker.test.tsx
```

Expected: FAIL — component not defined.

- [ ] **Step 3: Implement the picker**

Use Tailwind utility classes (Tailwind v4 is set up via `@tailwindcss/vite`; project palette tokens are exposed as CSS vars like `--border`, `--accent` and surfaced through the Tailwind theme — use plain utility classes like `border`, `bg-accent/10` and arbitrary values where needed).

```tsx
// frontend/src/components/CategoryIconPicker.tsx
import { CATEGORY_ICON_NAMES, type CategoryIconName } from '@cashflow/shared/categoryIcons'
import { CATEGORY_ICON_COMPONENTS } from './CategoryIcon'
import { cn } from '@/lib/utils'

type Props = {
  value: CategoryIconName | null
  onSelect: (next: CategoryIconName | null) => void
}

const CELL_BASE =
  'flex items-center justify-center h-12 rounded-md border border-[var(--border)] bg-transparent cursor-pointer hover:bg-[var(--accent)]/10'
const CELL_ACTIVE = 'border-[var(--accent)] bg-[var(--accent)]/15'

export function CategoryIconPicker({ value, onSelect }: Props) {
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(48px,1fr))] gap-1 max-h-[400px] overflow-y-auto">
      <button
        type="button"
        aria-pressed={value === null}
        onClick={() => onSelect(null)}
        className={cn(CELL_BASE, value === null && CELL_ACTIVE)}
        title="None"
      >
        <span className="text-[11px]">None</span>
      </button>
      {CATEGORY_ICON_NAMES.map((name) => {
        const Icon = CATEGORY_ICON_COMPONENTS[name]
        const active = value === name
        return (
          <button
            key={name}
            type="button"
            aria-pressed={active}
            onClick={() => onSelect(name)}
            className={cn(CELL_BASE, active && CELL_ACTIVE)}
            title={name}
            aria-label={name}
          >
            <Icon size={20} />
          </button>
        )
      })}
    </div>
  )
}
```

No global CSS edits — all styling lives in the component.

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd frontend && yarn test src/components/CategoryIconPicker.test.tsx
```

Expected: 3 passing.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/CategoryIconPicker.tsx frontend/src/components/CategoryIconPicker.test.tsx
git commit -m "feat(categories): CategoryIconPicker grid"
```

---

## Task 11: Settings → Categories tab

**Files:**
- Create: `frontend/src/pages/settings/tabs/CategoriesTab.tsx`
- Test: `frontend/src/pages/settings/tabs/CategoriesTab.test.tsx`
- Modify: `frontend/src/pages/settings/SettingsPage.tsx`
- Modify: `frontend/src/pages/settings/useActiveSettingsTopTab.ts`
- Modify: `frontend/src/App.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// frontend/src/pages/settings/tabs/CategoriesTab.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { CategoriesTab } from './CategoriesTab'
import * as api from '../../../lib/api'
import { _resetCategoriesCacheForTest } from '../../../lib/useCategories'

describe('CategoriesTab', () => {
  beforeEach(() => {
    _resetCategoriesCacheForTest()
    vi.restoreAllMocks()
  })

  it('lists categories with current icon and opens picker', async () => {
    vi.spyOn(api, 'getJson').mockResolvedValue([
      { id: 1, householdId: 1, name: 'Coffee', icon: null,
        createdAt: '', updatedAt: '' },
      { id: 2, householdId: 1, name: 'Rent', icon: 'Home',
        createdAt: '', updatedAt: '' },
    ])
    const patchSpy = vi
      .spyOn(api, 'patchJson')
      .mockResolvedValue({ id: 1, householdId: 1, name: 'Coffee', icon: 'Coffee',
        createdAt: '', updatedAt: '' })
    render(<CategoriesTab />)
    await waitFor(() => screen.getByText('Coffee'))
    await userEvent.click(screen.getByRole('button', { name: /edit icon for Coffee/i }))
    await userEvent.click(await screen.findByRole('button', { name: /^Coffee$/i }))
    await waitFor(() => {
      expect(patchSpy).toHaveBeenCalledWith('/api/categories/1', { icon: 'Coffee' })
    })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd frontend && yarn test src/pages/settings/tabs/CategoriesTab.test.tsx
```

Expected: FAIL — component not defined.

- [ ] **Step 3: Implement the tab**

```tsx
// frontend/src/pages/settings/tabs/CategoriesTab.tsx
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Dialog, DialogBody, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { CategoryIcon } from '../../../components/CategoryIcon'
import { CategoryIconPicker } from '../../../components/CategoryIconPicker'
import { useCategories } from '../../../lib/useCategories'
import { patchJson } from '../../../lib/api'
import type { CategoryIconName } from '@cashflow/shared/categoryIcons'
import type { Category } from '../../../types/api'

export function CategoriesTab() {
  const { categories, refresh } = useCategories()
  const [editing, setEditing] = useState<Category | null>(null)
  const [err, setErr] = useState<string | null>(null)

  async function setIcon(cat: Category, next: CategoryIconName | null) {
    setErr(null)
    try {
      await patchJson<Category>(`/api/categories/${cat.id}`, { icon: next })
      await refresh()
      setEditing(null)
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not update icon')
    }
  }

  return (
    <Card>
      <h2>Categories</h2>
      <p>Set an icon for each category. Icons appear in budgets, transactions, and dashboard.</p>
      {err ? <div role="alert">{err}</div> : null}
      <ul className="flex flex-col divide-y divide-[var(--border)]">
        {categories.map((cat) => (
          <li
            key={cat.id}
            className="flex items-center gap-3 py-2"
          >
            <CategoryIcon name={cat.name} size={20} />
            <span className="flex-1">{cat.name}</span>
            <Button
              variant="ghost"
              aria-label={`Edit icon for ${cat.name}`}
              onClick={() => setEditing(cat)}
            >
              Change
            </Button>
          </li>
        ))}
      </ul>
      <Dialog open={editing != null} onOpenChange={(o) => { if (!o) setEditing(null) }}>
        <DialogHeader>
          <DialogTitle>{editing ? `Icon for "${editing.name}"` : ''}</DialogTitle>
        </DialogHeader>
        <DialogBody>
          {editing ? (
            <CategoryIconPicker
              value={(editing.icon as CategoryIconName | null) ?? null}
              onSelect={(next) => setIcon(editing, next)}
            />
          ) : null}
        </DialogBody>
      </Dialog>
    </Card>
  )
}
```

- [ ] **Step 4: Register the tab**

In `frontend/src/pages/settings/SettingsPage.tsx`:

```ts
const TOP_TABS: TabItem[] = [
  { value: 'settings', label: 'Settings' },
  { value: 'imports', label: 'Imports' },
  { value: 'enrichment', label: 'Enrichment' },
  { value: 'contacts', label: 'Contacts' },
  { value: 'budgets', label: 'Budgets' },
  { value: 'categories', label: 'Categories' },
]

const TOP_TAB_PATHS: Record<SettingsTopTab, string> = {
  settings: '/settings/display',
  imports: '/settings/imports',
  enrichment: '/settings/enrichment',
  contacts: '/settings/contacts',
  budgets: '/settings/budgets',
  categories: '/settings/categories',
}
```

In `frontend/src/pages/settings/useActiveSettingsTopTab.ts`, extend the `SettingsTopTab` union to include `'categories'` (and update any list/`switch` that maps over the union — search the file for the existing tabs and add the new entry in the same place).

In `frontend/src/App.tsx`, add the route inside the `<Route path="settings">` block:

```tsx
<Route path="categories" element={<CategoriesTab />} />
```

And the import:

```tsx
import { CategoriesTab } from './pages/settings/tabs/CategoriesTab'
```

- [ ] **Step 5: Run tests + typecheck**

```bash
cd frontend && yarn test src/pages/settings/tabs/CategoriesTab.test.tsx
cd frontend && yarn build
```

Expected: tests pass; build succeeds.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/pages/settings/tabs/CategoriesTab.tsx \
        frontend/src/pages/settings/tabs/CategoriesTab.test.tsx \
        frontend/src/pages/settings/SettingsPage.tsx \
        frontend/src/pages/settings/useActiveSettingsTopTab.ts \
        frontend/src/App.tsx
git commit -m "feat(categories): Settings → Categories tab with icon picker"
```

---

## Task 12: Render `<CategoryIcon>` in BudgetsTab

**Files:**
- Modify: `frontend/src/pages/settings/tabs/BudgetsTab.tsx`

- [ ] **Step 1: Add the import**

Near the existing `import { Edit3, Plus, Trash2 } from 'lucide-react'`:

```tsx
import { CategoryIcon } from '../../../components/CategoryIcon'
```

- [ ] **Step 2: Render icon in the row**

In `BudgetsTab.tsx` line ~357 the cell is currently:

```tsx
<TableCell>{budget.category ?? 'Overall'}</TableCell>
```

Replace with:

```tsx
<TableCell>
  <span className="inline-flex items-center gap-1.5">
    <CategoryIcon name={budget.category} />
    {budget.category ?? 'Overall'}
  </span>
</TableCell>
```

No global CSS edits.

- [ ] **Step 3: Run the existing BudgetsTab test to confirm no regression**

```bash
cd frontend && yarn test src/pages/settings/tabs/BudgetsTab.test.tsx
```

Expected: still passes (icons render as `<Tag>` with no API responder in test — fine).

- [ ] **Step 4: Commit**

```bash
git add frontend/src/pages/settings/tabs/BudgetsTab.tsx
git commit -m "feat(categories): render icons in BudgetsTab"
```

---

## Task 13: Render `<CategoryIcon>` in TransactionsPage

**Files:**
- Modify: `frontend/src/pages/TransactionsPage.tsx`

- [ ] **Step 1: Add the import**

```tsx
import { CategoryIcon } from '../components/CategoryIcon'
```

- [ ] **Step 2: Render in the category cell**

Find the category `<TableCell>` that displays `t.finalCategory` (search for `finalCategory` near `TableCell` around line 1605 placeholder use). Wrap the text:

```tsx
<TableCell>
  <span className="inline-flex items-center gap-1.5">
    <CategoryIcon name={t.finalCategory} />
    <CategoryCloudPicker
      value={cat}
      onChange={setCat}
      options={categoryOptions}
      placeholder={t.finalCategory ?? ''}
    />
  </span>
</TableCell>
```

- [ ] **Step 3: Run TransactionsPage tests**

```bash
cd frontend && yarn test src/pages/TransactionsPage
```

Expected: passes (if no test file, run `yarn build` for typecheck instead).

- [ ] **Step 4: Commit**

```bash
git add frontend/src/pages/TransactionsPage.tsx
git commit -m "feat(categories): render icons in TransactionsPage row"
```

---

## Task 14: Render icons in CategoryCloudPicker options + ReviewInbox row

**Files:**
- Modify: `frontend/src/components/CategoryCloudPicker.tsx`
- Modify: `frontend/src/pages/ReviewInboxPage.tsx`

- [ ] **Step 1: Render icon beside each option chip**

In `CategoryCloudPicker.tsx`, inside the option button render (find the JSX that renders each chip from `arrangedOptions`), prepend a `<CategoryIcon>` inside an inline-flex wrapper so callers' `itemClassName` still controls the button chrome:

```tsx
import { CategoryIcon } from './CategoryIcon'
...
<button
  key={option}
  type="button"
  className={itemClassName}
  onClick={() => { onChange(option); setOpen(false) }}
>
  <span className="inline-flex items-center gap-1.5">
    <CategoryIcon name={option} />
    {option}
  </span>
</button>
```

(Match the file's existing JSX shape — keep the existing `className` / `key` patterns.)

- [ ] **Step 2: Render icon beside the chosen category in ReviewInboxPage selected row summary**

In `ReviewInboxPage.tsx`, find where the chosen `category` string is displayed alongside the selection summary (look near the `categoryPickerRef` block and the row category cell). Wrap with:

```tsx
<span className="inline-flex items-center gap-1.5">
  <CategoryIcon name={category || selectedRow?.finalCategory} />
  {category || selectedRow?.finalCategory || '—'}
</span>
```

Adjust to match the local variable names used in the file.

Add the import:

```tsx
import { CategoryIcon } from '../components/CategoryIcon'
```

- [ ] **Step 3: Run ReviewInboxPage tests**

```bash
cd frontend && yarn test src/pages/ReviewInboxPage
```

Expected: passes (or run `yarn build` if no test file).

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/CategoryCloudPicker.tsx frontend/src/pages/ReviewInboxPage.tsx
git commit -m "feat(categories): render icons in CategoryCloudPicker + ReviewInbox row"
```

---

## Task 15: Render `<CategoryIcon>` in DashboardPage breakdowns

**Files:**
- Modify: `frontend/src/pages/DashboardPage.tsx`

- [ ] **Step 1: Add the import**

```tsx
import { CategoryIcon } from '../components/CategoryIcon'
```

- [ ] **Step 2: Render in every category list/row**

Search `DashboardPage.tsx` for every place a category name appears in list/row form (e.g. `r.category ?? '(uncategorized)'` around line 437, and any "Top growers" / "Top categories" cells that show a label). For each, replace bare text with:

```tsx
<span className="inline-flex items-center gap-1.5">
  <CategoryIcon name={r.category} />
  {r.category ?? '(uncategorized)'}
</span>
```

Do **not** modify Recharts axis-tick labels — recharts ticks render as `<text>` in SVG and can't host arbitrary React. List/legend renderings only.

- [ ] **Step 3: Verify the page builds + smoke-test**

```bash
cd frontend && yarn build
```

Expected: success.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/pages/DashboardPage.tsx
git commit -m "feat(categories): render icons in DashboardPage breakdown lists"
```

---

## Task 16: End-to-end manual smoke

- [ ] **Step 1: Run backend + frontend dev**

```bash
cd backend && yarn dev   # terminal 1
cd frontend && yarn dev  # terminal 2
```

- [ ] **Step 2: Walk through the flow**

  1. Open http://localhost:5173/settings/categories.
  2. Confirm the list shows every existing category from the backfill.
  3. Click "Change" on one row; pick `Coffee`; confirm icon appears next to the row.
  4. Open /transactions; confirm icon renders beside the category in the chosen row.
  5. Open /settings/budgets; confirm icon beside any budget for the same category.
  6. Open /review; confirm icon in the category picker chip cloud.
  7. Open / (dashboard); confirm icon in the category breakdown list (chart axes intentionally untouched).

- [ ] **Step 3: Run full test suites**

```bash
cd backend && yarn test
cd frontend && yarn test
```

Expected: all green.

- [ ] **Step 4: Commit nothing; task is verification only.**

---

## Self-Review Checklist

- [x] Spec coverage:
  - Storage in DB → Task 2/3 (model + migration)
  - First-class entity promotion → Tasks 2, 5, 6, 7 (model, backfill, hooks, ensureCategory)
  - lucide-react → Task 1, 9 (whitelist + component)
  - Settings → Categories tab → Task 11
  - Render in Budgets / Transactions / Review Inbox / Dashboard → Tasks 12, 13, 14, 15
  - Icon-only (no color) → all tasks honor; model + API + picker scoped to `icon`.
- [x] Placeholders: each step contains real code; no TBD/TODO.
- [x] Type consistency: `Category`, `CategoryIconName`, `CATEGORY_ICON_NAMES`, `CATEGORY_ICON_COMPONENTS`, `ensureCategory(householdId, name)`, `useCategories()` shape constant across tasks.
- [x] Test-first ordering preserved on every task that adds runtime code.
