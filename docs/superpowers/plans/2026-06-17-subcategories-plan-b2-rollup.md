# Subcategories — Plan B2: Subtree Rollup

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make category reports roll a node's spend up its parent chain (parent total = own direct spend + all descendants), keyed by `categoryId`, while keeping every existing API response backward-compatible.

**Architecture:** Add a shared rollup utility (`backend/src/categories/rollup.ts`): load a household's category tree into a parent/name/depth map, then fold a flat `Map<categoryId, amount>` up each node's ancestor chain. Thread a category **id** through `splitTxnByItems` (`item.categoryOverrideId ?? item.inferredCategoryId ?? txn.finalCategoryId`) and `loadItemAllocationContext` so item-level splits roll up by id too. Each aggregator additionally carries `categoryId` in its grouping value (existing string outputs unchanged). Routes attach a rolled-up tree as an **additive** response field (`categoryTree`); the current frontend ignores it (renders the flat list as before), Plan C consumes it. Finally backfill the null `*CategoryId` rows that B1's static-write paths left (the `TODO(B2)` markers).

**Tech Stack:** Express + Sequelize (dual-dialect SQLite/Postgres), `node:test` via `tsx`, colocated tests.

## Global Constraints

- Worktree root: `/Users/connoradams/Developer/cashflow/.claude/worktrees/subcategories-plan-b2` (no local `node_modules` — deps resolve via walk-up to the main checkout).
- **Run tests with `tsx` DIRECTLY (not `yarn tsx`)**, PATH-prefixed:
  `cd backend && PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH tsx --import ./test/setup.ts --test src/<path>.test.ts`
- Workspace scripts also need the PATH prefix: `PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH yarn workspace cashflow-backend run typecheck` (likewise `lint`, `test`).
- Migrations: JS in `backend/src/migrations/`, `YYYYMMDD...-slug.js`; tests in `backend/src/migrations/__tests__/`. Dual-dialect; plain SQL / nullable columns only — no table recreation.
- `underscored: true`. Household-scoped everywhere.
- **Backward compatibility is mandatory**: do NOT remove or rename existing response fields, do NOT change existing aggregator return shapes except to ADD a `categoryId` field. Existing string `category` fields stay populated (resolved from the node's leaf name when an id is present, else the legacy string).
- Builds on B1 (already on this branch): `Transaction.finalCategoryId` / `autoCategoryId` / `categoryOverrideId`; `ExternalOrderItem.inferredCategoryId` / `categoryOverrideId`; `Rule.categoryId`; `BudgetTarget.categoryId`; `resolveCategoryIdByName`. Category model has `parentId`/`nameKey`.
- **Import models directly, not the `../models` barrel, in `backend/src/categories/*`**: the barrel re-exports Transaction/Rule/BudgetTarget/ExternalOrderItem whose `beforeSave` hooks dynamic-import `categories/*` — importing the barrel from a `categories/*` module creates an import cycle the `fallow` CI audit fails on (it blocked B1's PR). Always `import { Category } from '../models/Category'` etc.
- The CI gates `code-audit` (jscpd ratchet) and `PR code intelligence` (fallow audit, new-only, fail-on-issues) WILL fail the PR on any new import cycle, dead-code finding, or duplication in changed files — keep new files cycle-free and avoid copy-pasting near-identical blocks (extract shared helpers).
- Commits: NO co-author trailers. Stage only each task's files (never `git add -A`, never `yarn.lock`). Prefix commit with `PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH`.

---

### Task 1: Category tree loader + subtree rollup utility

**Files:**
- Create: `backend/src/categories/rollup.ts`
- Test: `backend/src/categories/rollup.test.ts`

**Interfaces:**
- Consumes: `Category` model.
- Produces:
  - `type CategoryTree = { parentById: Map<number, number | null>; nameById: Map<number, string>; depthById: Map<number, number>; pathById: Map<number, string> }`
  - `loadCategoryTree(householdId: number, opts?: { transaction?: import('sequelize').Transaction }): Promise<CategoryTree>` — one query, builds the maps in memory.
  - `rollupByCategoryId(rawByCategoryId: Map<number, number>, tree: CategoryTree): Map<number, number>` — returns a map where each node id maps to its own spend + all descendants' spend (fold each raw entry up its ancestor chain).
  - `type RollupRow = { categoryId: number; name: string; path: string; parentId: number | null; depth: number; directTotal: number; rolledTotal: number }`
  - `buildRollupRows(rawByCategoryId: Map<number, number>, tree: CategoryTree): RollupRow[]` — one row per node that has either direct or rolled spend, sorted by path.

- [ ] **Step 1: Write the failing test**

```ts
// backend/src/categories/rollup.test.ts
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { sequelize } from '../db';
import { Category, Household } from '../models';
import { loadCategoryTree, rollupByCategoryId, buildRollupRows } from './rollup';

let householdId: number;
let work: number, expenses: number, internet: number;
beforeEach(async () => {
  await sequelize.sync({ force: true });
  householdId = (await Household.create({ name: 'T' })).id;
  work = (await Category.create({ householdId, name: 'Work', icon: null, parentId: null })).id;
  expenses = (await Category.create({ householdId, name: 'Expenses', icon: null, parentId: work })).id;
  internet = (await Category.create({ householdId, name: 'Internet', icon: null, parentId: expenses })).id;
});

test('loadCategoryTree builds parent/name/depth/path maps', async () => {
  const tree = await loadCategoryTree(householdId);
  assert.equal(tree.parentById.get(internet), expenses);
  assert.equal(tree.parentById.get(work), null);
  assert.equal(tree.nameById.get(internet), 'Internet');
  assert.equal(tree.depthById.get(work), 0);
  assert.equal(tree.depthById.get(internet), 2);
  assert.equal(tree.pathById.get(internet), 'Work / Expenses / Internet');
});

test('rollupByCategoryId folds descendants into ancestors (no double count)', async () => {
  const tree = await loadCategoryTree(householdId);
  // parent directly tagged $50, child $20, grandchild $30
  const raw = new Map<number, number>([[work, 50], [expenses, 20], [internet, 30]]);
  const rolled = rollupByCategoryId(raw, tree);
  assert.equal(rolled.get(internet), 30);
  assert.equal(rolled.get(expenses), 50);  // 20 + 30
  assert.equal(rolled.get(work), 100);      // 50 + 20 + 30
});

test('buildRollupRows returns sorted rows with direct + rolled totals', async () => {
  const tree = await loadCategoryTree(householdId);
  const raw = new Map<number, number>([[work, 50], [internet, 30]]);
  const rows = buildRollupRows(raw, tree);
  const byId = new Map(rows.map((r) => [r.categoryId, r]));
  assert.equal(byId.get(work)!.directTotal, 50);
  assert.equal(byId.get(work)!.rolledTotal, 80);
  assert.equal(byId.get(internet)!.directTotal, 30);
  assert.equal(byId.get(internet)!.rolledTotal, 30);
  assert.equal(byId.get(internet)!.path, 'Work / Expenses / Internet');
  // expenses has no direct spend but is an ancestor of internet → appears with rolled 30
  assert.equal(byId.get(expenses)!.directTotal, 0);
  assert.equal(byId.get(expenses)!.rolledTotal, 30);
});

test('rollup ignores ids not in the tree (stale/cross-household) without throwing', async () => {
  const tree = await loadCategoryTree(householdId);
  const rolled = rollupByCategoryId(new Map([[999999, 10]]), tree);
  assert.equal(rolled.get(999999), undefined);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH tsx --import ./test/setup.ts --test src/categories/rollup.test.ts`
Expected: FAIL — `Cannot find module './rollup'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// backend/src/categories/rollup.ts
import type { Transaction } from 'sequelize';
// Import the model class directly, NOT the '../models' barrel — the barrel
// re-exports models whose hooks dynamic-import categories/* modules, which the
// fallow audit flags as an import cycle (this bit B1; see Global Constraints).
import { Category } from '../models/Category';

export type CategoryTree = {
  parentById: Map<number, number | null>;
  nameById: Map<number, string>;
  depthById: Map<number, number>;
  pathById: Map<number, string>;
};

export type RollupRow = {
  categoryId: number;
  name: string;
  path: string;
  parentId: number | null;
  depth: number;
  directTotal: number;
  rolledTotal: number;
};

export async function loadCategoryTree(
  householdId: number,
  opts: { transaction?: Transaction } = {},
): Promise<CategoryTree> {
  const rows = await Category.findAll({
    where: { householdId },
    attributes: ['id', 'parentId', 'name'],
    transaction: opts.transaction,
  });
  const parentById = new Map<number, number | null>();
  const nameById = new Map<number, string>();
  for (const r of rows) {
    parentById.set(r.id, r.parentId);
    nameById.set(r.id, r.name);
  }
  const depthById = new Map<number, number>();
  const pathById = new Map<number, string>();
  const resolve = (id: number): { depth: number; path: string } => {
    const cached = pathById.get(id);
    if (cached != null) return { depth: depthById.get(id)!, path: cached };
    const parent = parentById.get(id) ?? null;
    const name = nameById.get(id) ?? '';
    if (parent == null || !parentById.has(parent)) {
      depthById.set(id, 0);
      pathById.set(id, name);
      return { depth: 0, path: name };
    }
    const up = resolve(parent);
    const depth = up.depth + 1;
    const path = `${up.path} / ${name}`;
    depthById.set(id, depth);
    pathById.set(id, path);
    return { depth, path };
  };
  for (const id of parentById.keys()) resolve(id);
  return { parentById, nameById, depthById, pathById };
}

export function rollupByCategoryId(
  rawByCategoryId: Map<number, number>,
  tree: CategoryTree,
): Map<number, number> {
  const rolled = new Map<number, number>();
  for (const [categoryId, amount] of rawByCategoryId) {
    if (!tree.parentById.has(categoryId)) continue; // unknown/stale id — skip
    let current: number | null = categoryId;
    while (current != null && tree.parentById.has(current)) {
      rolled.set(current, (rolled.get(current) ?? 0) + amount);
      current = tree.parentById.get(current) ?? null;
    }
  }
  return rolled;
}

export function buildRollupRows(
  rawByCategoryId: Map<number, number>,
  tree: CategoryTree,
): RollupRow[] {
  const rolled = rollupByCategoryId(rawByCategoryId, tree);
  const ids = new Set<number>([...rolled.keys()]);
  const rows: RollupRow[] = [];
  for (const id of ids) {
    rows.push({
      categoryId: id,
      name: tree.nameById.get(id) ?? '',
      path: tree.pathById.get(id) ?? '',
      parentId: tree.parentById.get(id) ?? null,
      depth: tree.depthById.get(id) ?? 0,
      directTotal: rawByCategoryId.get(id) ?? 0,
      rolledTotal: rolled.get(id) ?? 0,
    });
  }
  rows.sort((a, b) => a.path.localeCompare(b.path));
  return rows;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH tsx --import ./test/setup.ts --test src/categories/rollup.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH \
git add backend/src/categories/rollup.ts backend/src/categories/rollup.test.ts && \
git commit -m "feat(categories): add category tree loader + subtree rollup utility"
```

---

### Task 2: Thread `categoryId` through `splitTxnByItems`

**Files:**
- Modify: `backend/src/import/splitTxnByItems.ts`
- Test: `backend/src/import/splitTxnByItems.categoryId.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces (additive — existing string `category` stays):
  - `AllocatorTxn` gains `finalCategoryId: number | null`.
  - `AllocatorItem` gains `inferredCategoryId: number | null` and `categoryOverrideId: number | null`.
  - `CategoryAllocation` gains `categoryId: number | null`.
  - New internal `effectiveCategoryId(item, txnCategoryId)` = `item.categoryOverrideId ?? item.inferredCategoryId ?? txnCategoryId`.
  - Every returned allocation sets `categoryId` alongside the existing `category` string.

- [ ] **Step 1: Write the failing test**

```ts
// backend/src/import/splitTxnByItems.categoryId.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitTxnByItems } from './splitTxnByItems';

const txn = {
  id: 1, amount: '-100', currency: 'CAD',
  finalCategory: 'Shopping', finalCategoryId: 7,
  finalBusiness: false, finalSplitType: 'me', businessAmount: '0',
};

test('no items → single allocation carries txn finalCategoryId', () => {
  const out = splitTxnByItems({ txn, links: [], ordersById: new Map(), itemsByOrder: new Map() });
  assert.equal(out.length, 1);
  assert.equal(out[0].categoryId, 7);
  assert.equal(out[0].category, 'Shopping');
});

test('item override id wins over inferred id wins over txn id', () => {
  const ordersById = new Map([[10, { id: 10, subtotal: '100', tax: '0', shipping: '0', total: '100', currency: 'CAD' }]]);
  const itemsByOrder = new Map([[10, [
    { id: 1, externalOrderId: 10, title: 'A', lineTotal: '60', inferredCategory: 'Food', inferredCategoryId: 3, categoryOverride: 'Treats', categoryOverrideId: 5 },
    { id: 2, externalOrderId: 10, title: 'B', lineTotal: '40', inferredCategory: 'Books', inferredCategoryId: 8, categoryOverride: null, categoryOverrideId: null },
  ]]]);
  const links = [{ externalOrderId: 10, linkedAmount: '-100' }];
  const out = splitTxnByItems({ txn, links, ordersById, itemsByOrder });
  const byCat = new Map(out.map((a) => [a.categoryId, a]));
  assert.ok(byCat.has(5)); // override id
  assert.ok(byCat.has(8)); // inferred id (no override)
});
```

> Match the real `AllocatorOrder`/`AllocatorItem` field names by reading `splitTxnByItems.ts` first (e.g. `lineTotal` vs `price`); keep the `categoryId` assertions identical.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH tsx --import ./test/setup.ts --test src/import/splitTxnByItems.categoryId.test.ts`
Expected: FAIL — `categoryId` is undefined on allocations / `finalCategoryId` not accepted.

- [ ] **Step 3: Write minimal implementation**

In `backend/src/import/splitTxnByItems.ts`:
1. Add `finalCategoryId: number | null` to `AllocatorTxn`.
2. Add `inferredCategoryId: number | null` and `categoryOverrideId: number | null` to `AllocatorItem`.
3. Add `categoryId: number | null` to `CategoryAllocation`.
4. Add alongside the existing `effectiveCategory`:
```ts
function effectiveCategoryId(item: AllocatorItem, txnCategoryId: number | null): number | null {
  return item.categoryOverrideId ?? item.inferredCategoryId ?? txnCategoryId;
}
```
5. At EVERY place the function builds a `CategoryAllocation` (the no-usable-items early return, the per-item allocations, and any remainder/fallback allocation), add `categoryId`:
   - txn-level allocations: `categoryId: txn.finalCategoryId`.
   - per-item allocations: `categoryId: effectiveCategoryId(item, txn.finalCategoryId)`.
Keep the existing `category` string assignments exactly as they are (`effectiveCategory(item, txn.finalCategory)` etc.).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH tsx --import ./test/setup.ts --test src/import/splitTxnByItems.categoryId.test.ts`
Expected: PASS (2 tests). Then typecheck (callers pass new required fields — Tasks 4-6 update them; until then typecheck may flag missing `finalCategoryId` at call sites, which those tasks fix. If typecheck fails ONLY on those not-yet-updated call sites, that is expected; note it and proceed — Task 8 reconciles all callers).

> To avoid a broken intermediate typecheck, make the three new `AllocatorTxn`/`AllocatorItem`/`CategoryAllocation` fields **required** but update callers in the SAME commit is not possible across tasks — so make `finalCategoryId`/`inferredCategoryId`/`categoryOverrideId` **optional with `?: number | null`** on the input types (defaulting to `null` via `?? null` inside the function). This keeps existing callers compiling. `CategoryAllocation.categoryId` is always emitted (non-optional output).

- [ ] **Step 5: Commit**

```bash
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH \
git add backend/src/import/splitTxnByItems.ts backend/src/import/splitTxnByItems.categoryId.test.ts && \
git commit -m "feat(categories): thread categoryId through splitTxnByItems allocations"
```

---

### Task 3: `loadItemAllocationContext` loads item category ids

**Files:**
- Modify: `backend/src/summary/loadItemAllocations.ts`
- Test: `backend/src/summary/loadItemAllocations.categoryId.test.ts` (integration-light: build orders/items, assert the context items carry ids)

**Interfaces:**
- Consumes: `ExternalOrderItem` (now has `inferredCategoryId`/`categoryOverrideId` from B1).
- Produces: the `AllocatorItem` objects built into `itemsByOrder` now include `inferredCategoryId` and `categoryOverrideId` (read from the `ExternalOrderItem` rows). Existing string fields unchanged.

- [ ] **Step 1: Write the failing test**

```ts
// backend/src/summary/loadItemAllocations.categoryId.test.ts
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { sequelize } from '../db';
import { Household, ExternalOrder, ExternalOrderItem, Transaction, TransactionOrderLink, Account } from '../models';
import { loadItemAllocationContext } from './loadItemAllocations';

let householdId: number;
beforeEach(async () => { await sequelize.sync({ force: true }); householdId = (await Household.create({ name: 'T' })).id; });

test('context items carry inferredCategoryId / categoryOverrideId', async () => {
  const account = await Account.create({ householdId, name: 'A', type: 'chequing', currency: 'CAD' });
  const txn = await Transaction.create({ householdId, accountId: account.id, date: '2026-01-01', amount: -100, currency: 'CAD', descriptionRaw: 'x' } as never);
  const order = await ExternalOrder.create({ householdId, vendor: 'amazon', source: 'amazon', currency: 'CAD' } as never);
  await ExternalOrderItem.create({ externalOrderId: order.id, title: 'Milk', inferredCategory: 'Groceries' } as never);
  await TransactionOrderLink.create({ transactionId: txn.id, externalOrderId: order.id, status: 'accepted', linkedAmount: '-100' } as never);
  const ctx = await loadItemAllocationContext([txn.id]);
  const items = ctx.itemsByOrder.get(order.id)!;
  assert.ok('inferredCategoryId' in items[0]);
  assert.ok('categoryOverrideId' in items[0]);
});
```

> Adjust create() fields to the real models (read them); the new beforeSave hook from B1 will set the item's `inferredCategoryId` when a household-scoped order exists. Keep the `in` assertions.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH tsx --import ./test/setup.ts --test src/summary/loadItemAllocations.categoryId.test.ts`
Expected: FAIL — items lack the id fields.

- [ ] **Step 3: Write minimal implementation**

In `backend/src/summary/loadItemAllocations.ts`, where it maps `ExternalOrderItem` rows into `AllocatorItem` objects (the `itemsByOrder` build), add `inferredCategoryId: it.inferredCategoryId` and `categoryOverrideId: it.categoryOverrideId` to each item object (alongside the existing `inferredCategory`/`categoryOverride` strings). Ensure the `ExternalOrderItem.findAll` selects those columns (if it uses explicit `attributes`, add them; if no `attributes`, all columns load).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH tsx --import ./test/setup.ts --test src/summary/loadItemAllocations.categoryId.test.ts`
Expected: PASS. Then typecheck → no errors.

- [ ] **Step 5: Commit**

```bash
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH \
git add backend/src/summary/loadItemAllocations.ts backend/src/summary/loadItemAllocations.categoryId.test.ts && \
git commit -m "feat(categories): loadItemAllocationContext carries item category ids"
```

---

### Task 4: `aggregateMonthly` carries `categoryId`

**Files:**
- Modify: `backend/src/summary/aggregateMonthly.ts`
- Test: `backend/src/summary/aggregateMonthly.categoryId.test.ts`

**Interfaces:**
- Consumes: `splitTxnByItems` (now emits `categoryId`).
- Produces: `MonthlyTxnRow` gains `finalCategoryId?: number | null`; the no-items fallback allocation passes `categoryId: row.finalCategoryId ?? null`; each `categoryPoints` value gains a `categoryId: number | null` field (taken from `alloc.categoryId`). The grouping KEY stays string-based (`month\0currency\0category-string`) for backward compat; `categoryId` rides along in the value.

- [ ] **Step 1: Write the failing test**

```ts
// backend/src/summary/aggregateMonthly.categoryId.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aggregateMonthly } from './aggregateMonthly';

test('category points carry finalCategoryId', () => {
  const rows = [
    { id: 1, accountId: 1, date: '2026-01-15', currency: 'CAD', merchantRaw: null, merchantClean: null,
      finalCategory: 'Groceries', finalCategoryId: 42, finalBusiness: false, finalSplitType: 'me', amount: -50, txnType: null },
  ];
  const res = aggregateMonthly(rows as never, new Map());
  const pt = res.categoryPoints.find((p: { category: string | null }) => p.category === 'Groceries');
  assert.ok(pt);
  assert.equal((pt as { categoryId: number | null }).categoryId, 42);
});
```

> Read `aggregateMonthly.ts` for the exact `MonthlyResult.categoryPoints` element shape; assert on the real exported field. If `categoryPoints` is a Map internally and returned as an array, match that.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH tsx --import ./test/setup.ts --test src/summary/aggregateMonthly.categoryId.test.ts`
Expected: FAIL — `categoryId` undefined on points.

- [ ] **Step 3: Write minimal implementation**

In `backend/src/summary/aggregateMonthly.ts`:
1. Add `finalCategoryId?: number | null;` to `MonthlyTxnRow`.
2. In the `splitTxnByItems({ txn: {...} })` call, add `finalCategoryId: row.finalCategoryId ?? null` to the txn object.
3. In the no-items fallback allocation array, add `categoryId: row.finalCategoryId ?? null` to the single allocation object.
4. In the `categoryPoints` accumulation, add `categoryId: alloc.categoryId ?? null` to the default value object (the `catExisting` initializer). Leave the string key and `category` field unchanged.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH tsx --import ./test/setup.ts --test src/summary/aggregateMonthly.categoryId.test.ts`
Expected: PASS. Then run the existing `aggregateMonthly.test.ts` to confirm no regression + typecheck.

- [ ] **Step 5: Commit**

```bash
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH \
git add backend/src/summary/aggregateMonthly.ts backend/src/summary/aggregateMonthly.categoryId.test.ts && \
git commit -m "feat(categories): aggregateMonthly carries categoryId in points"
```

---

### Task 5: `aggregateDashboard` carries `categoryId`

**Files:**
- Modify: `backend/src/summary/aggregateDashboard.ts`
- Test: `backend/src/summary/aggregateDashboard.categoryId.test.ts`

**Interfaces:**
- Consumes: `splitTxnByItems`.
- Produces: `SummaryTxnRow` gains `finalCategoryId?: number | null`; the no-items fallback allocation passes `categoryId: row.finalCategoryId ?? null`; the `byCategory` value gains `categoryId: number | null` (from `alloc.category` → use `alloc.categoryId`). Grouping key unchanged.

- [ ] **Step 1: Write the failing test**

```ts
// backend/src/summary/aggregateDashboard.categoryId.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aggregateDashboard } from './aggregateDashboard';

test('dashboard category breakdown carries finalCategoryId', () => {
  const rows = [
    { id: 1, accountId: 1, date: '2026-01-15', currency: 'CAD', finalCategory: 'Dining', finalCategoryId: 9,
      finalBusiness: false, finalSplitType: 'me', merchantRaw: null, merchantClean: null, merchantCanonical: null,
      amount: -25, reviewFlag: false, txnType: null },
  ];
  const res = aggregateDashboard(rows as never, new Map() as never);
  // locate the Dining category bucket in the dashboard result and assert categoryId === 9
  const cats = (res as { byCategory?: Array<{ category: string | null; categoryId?: number | null }> }).byCategory
    ?? (res as { categories?: Array<{ category: string | null; categoryId?: number | null }> }).categories
    ?? [];
  const dining = cats.find((c) => c.category === 'Dining');
  assert.ok(dining, 'Dining bucket present');
  assert.equal(dining!.categoryId, 9);
});
```

> Read `aggregateDashboard.ts` for the real result field name holding the category breakdown and the call signature (it takes rows + an accountType map). Fix the assertion to the real shape.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH tsx --import ./test/setup.ts --test src/summary/aggregateDashboard.categoryId.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write minimal implementation**

In `backend/src/summary/aggregateDashboard.ts`:
1. Add `finalCategoryId?: number | null;` to `SummaryTxnRow`.
2. Add `finalCategoryId: row.finalCategoryId ?? null` to the `splitTxnByItems` txn object.
3. Add `categoryId: row.finalCategoryId ?? null` to the no-items fallback allocation.
4. Add `categoryId: alloc.categoryId ?? null` to the `byCategory` default value object. Leave the key and existing fields unchanged. If the result maps `byCategory` into an output array, include `categoryId` in that mapping.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH tsx --import ./test/setup.ts --test src/summary/aggregateDashboard.categoryId.test.ts`
Expected: PASS. Then existing `aggregateDashboard.test.ts` + typecheck.

- [ ] **Step 5: Commit**

```bash
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH \
git add backend/src/summary/aggregateDashboard.ts backend/src/summary/aggregateDashboard.categoryId.test.ts && \
git commit -m "feat(categories): aggregateDashboard carries categoryId in breakdown"
```

---

### Task 6: `aggregateSpendByCategory` (budgets) carries `categoryId`

**Files:**
- Modify: `backend/src/routes/budgets.ts`
- Test: `backend/src/routes/budgets.categoryId.test.ts`

**Interfaces:**
- Consumes: `splitTxnByItems`.
- Produces: `SpendRow` gains `finalCategoryId?: number | null`; `aggregateSpendByCategory` returns a map whose value gains `categoryId: number | null` (from `alloc.categoryId`). Existing `{ currency, category, spent }` fields unchanged; key unchanged.

- [ ] **Step 1: Write the failing test**

```ts
// backend/src/routes/budgets.categoryId.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aggregateSpendByCategory } from './budgets';

test('spend buckets carry finalCategoryId', () => {
  const rows = [
    { id: 1, currency: 'CAD', finalCategory: 'Fuel', finalCategoryId: 11, finalBusiness: false, finalSplitType: 'me', amount: -40, businessAmount: '0' },
  ];
  const out = aggregateSpendByCategory(rows as never);
  const bucket = [...out.values()].find((b) => b.category === 'Fuel');
  assert.ok(bucket);
  assert.equal((bucket as { categoryId?: number | null }).categoryId, 11);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH tsx --import ./test/setup.ts --test src/routes/budgets.categoryId.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write minimal implementation**

In `backend/src/routes/budgets.ts`:
1. Add `finalCategoryId?: number | null;` to `SpendRow`.
2. Update the `aggregateSpendByCategory` return type to `Map<string, { currency: string; category: string | null; categoryId: number | null; spent: number }>`.
3. Add `finalCategoryId: row.finalCategoryId ?? null` to the `splitTxnByItems` txn object and `categoryId: row.finalCategoryId ?? null` to the no-items fallback allocation.
4. In the bucket accumulation, add `categoryId: alloc.categoryId ?? null` to the default value object.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH tsx --import ./test/setup.ts --test src/routes/budgets.categoryId.test.ts`
Expected: PASS. Then existing `budgets.test.ts` + typecheck (the `aggregateSpendByCategory` return-type widening must not break `budgetBreachCheck.ts` consumers — they read `currency`/`category`/`spent`, so adding `categoryId` is safe).

- [ ] **Step 5: Commit**

```bash
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH \
git add backend/src/routes/budgets.ts backend/src/routes/budgets.categoryId.test.ts && \
git commit -m "feat(categories): aggregateSpendByCategory carries categoryId"
```

---

### Task 7: `aggregateSankey` carries `categoryId`

**Files:**
- Modify: `backend/src/summary/aggregateSankey.ts`
- Test: `backend/src/summary/aggregateSankey.categoryId.test.ts`

**Interfaces:**
- Consumes: nothing new (sankey has no item split).
- Produces: `SankeyTxnRow` gains `finalCategoryId?: number | null`; each category bucket gains `categoryId: number | null` (from `row.finalCategoryId`). The bucket KEY stays the resolved label string (backward compat); `categoryId` rides in the value. When multiple rows with the same label have different ids (shouldn't happen post-B1, but defensively), keep the first non-null id.

- [ ] **Step 1: Write the failing test**

```ts
// backend/src/summary/aggregateSankey.categoryId.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aggregateSankey } from './aggregateSankey';

test('sankey category buckets carry finalCategoryId', () => {
  const rows = [
    { id: 1, date: '2026-01-15', currency: 'CAD', finalCategory: 'Travel', finalCategoryId: 21, finalBusiness: false,
      merchantRaw: null, merchantClean: null, amount: -80, txnType: null, accountType: 'chequing' },
  ];
  const res = aggregateSankey(rows as never, 'CAD');
  // find the Travel category node/bucket in the sankey result and assert categoryId === 21
  const node = (res as { categories?: Array<{ label?: string; category?: string; categoryId?: number | null }> }).categories
    ?.find((c) => (c.label ?? c.category) === 'Travel');
  assert.ok(node, 'Travel node present');
  assert.equal(node!.categoryId, 21);
});
```

> Read `aggregateSankey.ts` for the actual result shape that exposes per-category buckets and adjust the assertion. If categories are only exposed as Sankey nodes, attach `categoryId` to the node payload for category nodes.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH tsx --import ./test/setup.ts --test src/summary/aggregateSankey.categoryId.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write minimal implementation**

In `backend/src/summary/aggregateSankey.ts`:
1. Add `finalCategoryId?: number | null;` to `SankeyTxnRow`.
2. In both category-bucket accumulation blocks (spend path + credit path), add `categoryId` to the default bucket value: `categoryId: row.finalCategoryId ?? null`, and when updating an existing bucket whose `categoryId` is null, set it from `row.finalCategoryId` if non-null (keep-first-non-null).
3. If category buckets are emitted as result nodes/rows, include `categoryId` in that output mapping.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH tsx --import ./test/setup.ts --test src/summary/aggregateSankey.categoryId.test.ts`
Expected: PASS. Then existing `aggregateSankey.test.ts` + typecheck.

- [ ] **Step 5: Commit**

```bash
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH \
git add backend/src/summary/aggregateSankey.ts backend/src/summary/aggregateSankey.categoryId.test.ts && \
git commit -m "feat(categories): aggregateSankey carries categoryId in buckets"
```

---

### Task 8: Select `finalCategoryId` in query sites + attach `categoryTree` to responses

**Files:**
- Modify: `backend/src/routes/summary.ts` (3 query sites: monthly, dashboard, period-insight), `backend/src/routes/sankey.ts`, `backend/src/routes/budgets.ts` (computeStatusForBudgets), `backend/src/routes/reports.ts`, `backend/src/routes/reporting.ts`, `backend/src/ai/insights.ts`
- Test: `backend/test/integration/categoryRollup.test.ts` (Postgres)

**Interfaces:**
- Consumes: `loadCategoryTree`, `buildRollupRows` (Task 1), the aggregators now carrying `categoryId`.
- Produces: every `Transaction.findAll` attribute list that includes `finalCategory` ALSO includes `finalCategoryId`. The `/api/summary/monthly`, `/api/summary/dashboard`, and `/api/sankey` responses gain an additive `categoryTree: RollupRow[]` field built from the aggregator's per-category `categoryId` totals via `buildRollupRows(rawMap, await loadCategoryTree(householdId))`. Existing response fields are untouched.

- [ ] **Step 1: Write the failing test**

```ts
// backend/test/integration/categoryRollup.test.ts
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { setupPgTestDb, teardownPgTestDb, type PgTestDb } from './_setup/pgTestDb.js';

let app: import('express').Express; let authed: ReturnType<typeof request.agent>; let testDb: PgTestDb;
before(async () => {
  testDb = await setupPgTestDb('category-rollup');
  app = (await import('../../src/app.js')).default;
  authed = request.agent(app);
  await authed.post('/api/auth/register').send({ email: 'roll@example.com', displayName: 'R', password: 'password123' });
  // Build Work > Internet, tag a txn to Internet, then assert the monthly rollup shows Work's rolledTotal includes it.
  const work = await authed.post('/api/categories').send({ name: 'Work', parentId: null });
  const internet = await authed.post('/api/categories').send({ name: 'Internet', parentId: work.body.id });
  // create an account + transaction tagged to Internet via the normal API
  // (use the real account + transaction create endpoints; tag finalCategory='Internet' so the beforeSave hook sets finalCategoryId)
});

after(async () => { await teardownPgTestDb(testDb); });

test('monthly response includes a categoryTree with parent rollup', async () => {
  const res = await authed.get('/api/summary/monthly?currency=CAD');
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.categoryTree), 'categoryTree present');
  // The exact totals depend on the seeded txn; assert the field exists and a Work node has rolledTotal >= its children.
});
```

> This integration test needs the real account/transaction create endpoints to seed a categorized txn. Read an existing integration test (e.g. `aiInbox.test.ts`, `transactionReceiptsWithItems.test.ts`) for the seed pattern, then assert: `categoryTree` exists on the monthly response, and the parent node's `rolledTotal` ≥ the leaf's. Keep it focused; the unit-level rollup correctness is already covered by Task 1.

- [ ] **Step 2: Run test to verify it fails**

Run (Postgres up): `cd backend && PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH yarn run test:integration --test-name-pattern 'monthly response includes a categoryTree'`
Expected: FAIL — `categoryTree` undefined.

- [ ] **Step 3: Write minimal implementation**

1. In each query site listed in Files, add `'finalCategoryId'` to the `attributes` array next to `'finalCategory'` (7 sites total — `summary.ts` ×3, `sankey.ts`, `budgets.ts`, `reports.ts`, `reporting.ts`, `insights.ts`).
2. In `summary.ts` `/monthly`: after `aggregateMonthly(...)`, build a raw map from `categoryPoints` (sum `sumAmount` per `categoryId`, skipping null ids; use absolute spend), then `const tree = await loadCategoryTree(householdId); res.json({ ...existing, categoryTree: buildRollupRows(rawMap, tree) })`. Get `householdId` from `currentAuth(req).household.id`.
3. In `summary.ts` `/dashboard`: same, from the dashboard category breakdown's `categoryId` totals.
4. In `sankey.ts`: same, from the sankey category buckets' `categoryId` totals.
5. `reports.ts` / `reporting.ts` / `insights.ts` / `budgets.ts` computeStatusForBudgets: ONLY add the `finalCategoryId` attribute (so the data is available); do NOT change their response shapes in B2 (rollup exposure for those is deferred — they don't render a category tree yet). Add a `// B2: finalCategoryId selected for future rollup` comment.

> Helper to avoid duplication: add `function rawSpendByCategoryId(points: Array<{ categoryId: number | null; sumAmount: number }>): Map<number, number>` inline or in `rollup.ts` that sums absolute spend per non-null categoryId. Reuse it in monthly/dashboard/sankey.

- [ ] **Step 4: Run the test**

Run (Postgres up): `cd backend && PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH yarn run test:integration --test-name-pattern 'categoryTree'`
Expected: PASS. Then typecheck + lint.

- [ ] **Step 5: Commit**

```bash
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH \
git add backend/src/routes/summary.ts backend/src/routes/sankey.ts backend/src/routes/budgets.ts backend/src/routes/reports.ts backend/src/routes/reporting.ts backend/src/ai/insights.ts backend/test/integration/categoryRollup.test.ts && \
git commit -m "feat(categories): select finalCategoryId + attach categoryTree rollup to summary/sankey responses"
```

---

### Task 9: Backfill the null `*CategoryId` rows left by static-write paths

**Files:**
- Create: `backend/src/migrations/20260623000001-backfill-static-write-category-ids.js`
- Test: `backend/src/migrations/__tests__/backfillStaticWriteCategoryIdsMigration.test.ts`

**Interfaces:**
- Produces: a migration that, for any row where the category STRING is non-null but the `*CategoryId` FK is null, resolves the id by `(household_id, name_key)` against root categories and sets it — closing the gap from B1's `TODO(B2)` (static `Model.update`/`bulkCreate` bypass the beforeSave hooks). Same matching logic as B1's backfill (Task 1 of B1).

- [ ] **Step 1: Write the failing test**

```ts
// backend/src/migrations/__tests__/backfillStaticWriteCategoryIdsMigration.test.ts
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
    auto_category_id: { type: DataTypes.INTEGER, allowNull: true },
    final_category: { type: DataTypes.STRING(128), allowNull: true },
    final_category_id: { type: DataTypes.INTEGER, allowNull: true },
  });
  await qi.bulkInsert('categories', [{ household_id: 1, parent_id: null, name: 'Groceries', name_key: 'groceries' }]);
  // a row that a static update left with the string set but the id null
  await qi.bulkInsert('transactions', [{ household_id: 1, auto_category: 'Groceries', auto_category_id: null, final_category: 'Groceries', final_category_id: null }]);
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  migration = require('../20260623000001-backfill-static-write-category-ids.js');
});
after(async () => { await sequelize.close(); });

test('backfills null *_category_id where the string is set', async () => {
  await migration.up(sequelize.getQueryInterface(), Sequelize);
  const [rows] = await sequelize.query('SELECT auto_category_id, final_category_id FROM transactions');
  const cat = (await sequelize.query('SELECT id FROM categories'))[0] as Array<{ id: number }>;
  assert.equal((rows as Array<Record<string, unknown>>)[0].auto_category_id, cat[0].id);
  assert.equal((rows as Array<Record<string, unknown>>)[0].final_category_id, cat[0].id);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH tsx --import ./test/setup.ts --test src/migrations/__tests__/backfillStaticWriteCategoryIdsMigration.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```js
// backend/src/migrations/20260623000001-backfill-static-write-category-ids.js
'use strict';

// (table, fkColumn, sourceStringColumn, hasHouseholdId) — same targets as 20260622000001, re-resolving only NULL fks.
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
  async up(queryInterface) {
    const [cats] = await queryInterface.sequelize.query(
      'SELECT id, household_id, name_key FROM categories WHERE parent_id IS NULL',
    );
    const byHouseholdKey = new Map();
    const byKey = new Map();
    for (const c of cats) {
      byHouseholdKey.set(`${c.household_id} ${c.name_key}`, c.id);
      if (!byKey.has(c.name_key)) byKey.set(c.name_key, c.id);
    }
    for (const [table, fkCol, srcCol, hasHousehold] of TARGETS) {
      const cols = hasHousehold ? `id, household_id, ${srcCol} AS src` : `id, ${srcCol} AS src`;
      const [rows] = await queryInterface.sequelize.query(
        `SELECT ${cols} FROM ${table} WHERE ${fkCol} IS NULL AND ${srcCol} IS NOT NULL`,
      );
      for (const row of rows) {
        if (String(row.src).trim() === '') continue;
        const key = normalizeName(row.src);
        const id = hasHousehold ? byHouseholdKey.get(`${row.household_id} ${key}`) : byKey.get(key);
        if (id == null) continue;
        await queryInterface.sequelize.query(
          `UPDATE ${table} SET ${fkCol} = :id WHERE id = :rowId`,
          { replacements: { id, rowId: row.id } },
        );
      }
    }
  },

  // Data-only backfill; down is a no-op (cannot distinguish backfilled from hook-set ids).
  async down() {},
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH tsx --import ./test/setup.ts --test src/migrations/__tests__/backfillStaticWriteCategoryIdsMigration.test.ts`
Expected: PASS.

- [ ] **Step 5: Remove the `TODO(B2)` markers**

Now that the backfill exists, update the two `TODO(B2)` comments in `backend/src/import/enrichment/aiBatchOverColdRows.ts` and `backend/src/import/categorizeReceiptItems.ts` to note the gap is now covered by migration `20260623000001` (the FK stays null momentarily on a static write but the next migration / a periodic resolve closes it). Change `TODO(B2)` → a plain note referencing the backfill migration. (Do NOT change the write behavior.)

> Optional belt-and-suspenders (only if trivial): pass `individualHooks: true` to those two `Model.update` calls so the beforeSave hook fires and sets the id immediately. If `individualHooks` materially changes behavior or perf, skip it — the backfill migration is the safety net.

- [ ] **Step 6: Commit**

```bash
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH \
git add backend/src/migrations/20260623000001-backfill-static-write-category-ids.js \
        backend/src/migrations/__tests__/backfillStaticWriteCategoryIdsMigration.test.ts \
        backend/src/import/enrichment/aiBatchOverColdRows.ts backend/src/import/categorizeReceiptItems.ts && \
git commit -m "feat(categories): backfill null categoryId left by static-write paths; resolve TODO(B2)"
```

---

### Task 10: `loadCategoryHints` returns full paths

**Files:**
- Modify: `backend/src/ai/suggestTransaction.ts`
- Test: `backend/src/ai/loadCategoryHints.paths.test.ts`

**Interfaces:**
- Consumes: `loadCategoryTree` (Task 1).
- Produces: `loadCategoryHints(householdId)` returns full **paths** (`Work / Expenses / Internet`) for the household's categories instead of bare leaf strings, by loading the tree and emitting `tree.pathById` values (sorted, deduped). The function signature is unchanged (`Promise<string[]>`). If `householdId` is null/absent, keep the legacy behavior (distinct strings from rules/transactions) so callers without a household still work.

- [ ] **Step 1: Write the failing test**

```ts
// backend/src/ai/loadCategoryHints.paths.test.ts
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { sequelize } from '../db';
import { Household, Category } from '../models';
import { loadCategoryHints } from './suggestTransaction';

let householdId: number;
beforeEach(async () => {
  await sequelize.sync({ force: true });
  householdId = (await Household.create({ name: 'T' })).id;
  const work = await Category.create({ householdId, name: 'Work', icon: null, parentId: null });
  const expenses = await Category.create({ householdId, name: 'Expenses', icon: null, parentId: work.id });
  await Category.create({ householdId, name: 'Internet', icon: null, parentId: expenses.id });
});

test('returns full paths for nested categories', async () => {
  const hints = await loadCategoryHints(householdId);
  assert.ok(hints.includes('Work / Expenses / Internet'));
  assert.ok(hints.includes('Work'));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH tsx --import ./test/setup.ts --test src/ai/loadCategoryHints.paths.test.ts`
Expected: FAIL — returns bare names, not paths.

- [ ] **Step 3: Write minimal implementation**

In `backend/src/ai/suggestTransaction.ts`, change `loadCategoryHints`: when `householdId` is provided, `const tree = await loadCategoryTree(householdId); return [...new Set(tree.pathById.values())].sort();`. Keep the existing rules/transactions-distinct fallback for the null-household case. Import `loadCategoryTree` from `../categories/rollup`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH tsx --import ./test/setup.ts --test src/ai/loadCategoryHints.paths.test.ts`
Expected: PASS. Then existing `aiSuggestion.test.ts` / `suggestTransaction` tests + typecheck.

- [ ] **Step 5: Commit**

```bash
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH \
git add backend/src/ai/suggestTransaction.ts backend/src/ai/loadCategoryHints.paths.test.ts && \
git commit -m "feat(categories): loadCategoryHints returns full category paths"
```

---

## Final verification

- [ ] Full backend unit suite green: `cd backend && PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH yarn workspace cashflow-backend run test` → `# fail 0`.
- [ ] Integration (Postgres): `cd backend && PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH yarn run test:integration` → green.
- [ ] Typecheck + lint clean.
- [ ] Migrate up/down round-trip on a scratch DB.
- [ ] Backward-compat spot check: an existing summary/dashboard/sankey response still contains all its prior fields; `categoryTree` is purely additive.

## What Plan B2 leaves to Plan C

- Frontend: render the `categoryTree` rollup (collapsed parent totals, expand to children) in the dashboard/monthly/sankey category views; picker path-syntax + manager page; **name-rename route + `syncCategoryLeafNameMirrors`** (rename UI lives on the manager page); AI deferred (accept-time) path creation.
- Exposing rollup on `reports.ts` / `reporting.ts` / `insights.ts` responses (B2 only selects the id there; rendering/consumption is C if needed).
