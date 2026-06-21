# Subcategories — Plan C1: id-authoritative write path + rename

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a category **id** the source of truth on writes (so a transaction can carry a *child* category id without the `beforeSave` hook clobbering it), let the transaction PATCH accept `categoryOverrideId`, and add category **name-rename** with leaf-name mirror fan-out.

**Architecture:** Replace the four B1 `beforeSave` hooks' inline string→root resolution with one shared `reconcileCategoryField(instance, strField, idField, householdId, tx)` helper that is **id-authoritative**: if the id field was explicitly changed, derive the string from that node's name (don't re-resolve); else if the string changed, resolve string→root id (legacy). The transaction PATCH accepts `categoryOverrideId` and sets the override + final ids. A new `syncCategoryLeafNameMirrors` service fans a renamed node's leaf name out to every string mirror; `PATCH /api/categories/:id` gains name-rename (sibling-conflict checked, mirror sync in one transaction).

**Tech Stack:** Express + Sequelize (dual-dialect SQLite/Postgres), `node:test` via `tsx`, colocated tests.

## Global Constraints

- Worktree root: `/Users/connoradams/Developer/cashflow/.claude/worktrees/subcategories-plan-c` (no local install; `@cashflow/shared` + `.bin` are symlinked into `node_modules`).
- **Run unit tests with DIRECT `tsx` (NOT `yarn tsx`)**, PATH-prefixed:
  `cd backend && PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH tsx --import ./test/setup.ts --test src/<path>.test.ts`
- Workspace scripts also PATH-prefixed: `PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH yarn workspace cashflow-backend run typecheck` (likewise `lint`, `test`).
- **Import models DIRECTLY** (`../models/Category`), never the `../models` barrel, from `backend/src/categories/*` — the barrel creates a fallow-flagged import cycle (it blocked B1's PR).
- **DRY for the CI ratchet:** the four model hooks must share ONE helper (`reconcileCategoryField`), not four copy-pasted blocks — jscpd/fallow gate new duplication.
- `nameKey = name.trim().toLocaleLowerCase('en-CA')` (reuse `normalizeCategoryName`).
- Household-scoped everywhere. Dual-dialect; no table recreation (no schema change in C1).
- Builds on B1+B2 (on this branch): `Category` (`parentId`/`nameKey`); `*CategoryId` FK columns + the B1 `beforeSave` hooks; `resolveCategoryIdByName` (root-only); `CategoryError` (codes incl. `sibling_conflict`, `not_found`).
- Commits: NO co-author trailers. Stage only each task's files (never `git add -A`, never `yarn.lock`). Prefix commit with `PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH`.

---

### Task 1: `reconcileCategoryField` — the id-authoritative helper

**Files:**
- Create: `backend/src/categories/reconcileCategoryField.ts`
- Test: `backend/src/categories/reconcileCategoryField.test.ts`

**Interfaces:**
- Consumes: `Category` model, `resolveCategoryIdByName`.
- Produces: `reconcileCategoryField(opts): Promise<void>` mutating an instance's string+id pair in place. Signature:
  ```ts
  reconcileCategoryField(opts: {
    instance: { changed(f: string): boolean; get(f: string): unknown; set(f: string, v: unknown): void };
    householdId: number;
    strField: string;   // e.g. 'finalCategory'
    idField: string;    // e.g. 'finalCategoryId'
    transaction?: import('sequelize').Transaction;
  }): Promise<void>
  ```
  Rules: if `instance.changed(idField)` → the id is authoritative: derive `strField` from the node's `name` (or null when id is null), do NOT touch the id. Else if `instance.changed(strField)` → resolve `strField` → root id via `resolveCategoryIdByName`, set `idField`. Else no-op.

- [ ] **Step 1: Write the failing test**

```ts
// backend/src/categories/reconcileCategoryField.test.ts
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { sequelize } from '../db';
import { Category, Household } from '../models';
import { reconcileCategoryField } from './reconcileCategoryField';

let householdId: number;
let root: number, child: number;
beforeEach(async () => {
  await sequelize.sync({ force: true });
  householdId = (await Household.create({ name: 'T' })).id;
  const work = await Category.create({ householdId, name: 'Work', icon: null, parentId: null });
  root = work.id;
  child = (await Category.create({ householdId, name: 'Internet', icon: null, parentId: work.id })).id;
});

// minimal fake instance implementing changed/get/set over a plain record
function fakeInstance(initial: Record<string, unknown>, dirty: Set<string>) {
  const data = { ...initial };
  return {
    data,
    changed: (f: string) => dirty.has(f),
    get: (f: string) => data[f],
    set: (f: string, v: unknown) => { data[f] = v; },
  };
}

test('id change is authoritative: derives the string from the node name', async () => {
  const inst = fakeInstance({ finalCategory: 'STALE', finalCategoryId: child }, new Set(['finalCategoryId']));
  await reconcileCategoryField({ instance: inst, householdId, strField: 'finalCategory', idField: 'finalCategoryId' });
  assert.equal(inst.data.finalCategory, 'Internet'); // derived from child node
  assert.equal(inst.data.finalCategoryId, child);    // id untouched
});

test('id set to null derives a null string', async () => {
  const inst = fakeInstance({ finalCategory: 'Internet', finalCategoryId: null }, new Set(['finalCategoryId']));
  await reconcileCategoryField({ instance: inst, householdId, strField: 'finalCategory', idField: 'finalCategoryId' });
  assert.equal(inst.data.finalCategory, null);
});

test('string change with no id change resolves to a ROOT id (legacy path)', async () => {
  const inst = fakeInstance({ finalCategory: 'Groceries', finalCategoryId: null }, new Set(['finalCategory']));
  await reconcileCategoryField({ instance: inst, householdId, strField: 'finalCategory', idField: 'finalCategoryId' });
  const node = await Category.findByPk(inst.data.finalCategoryId as number);
  assert.equal(node?.name, 'Groceries');
  assert.equal(node?.parentId, null); // root
});

test('both dirty → id wins (string overwritten from node name)', async () => {
  const inst = fakeInstance({ finalCategory: 'whatever', finalCategoryId: child }, new Set(['finalCategory', 'finalCategoryId']));
  await reconcileCategoryField({ instance: inst, householdId, strField: 'finalCategory', idField: 'finalCategoryId' });
  assert.equal(inst.data.finalCategory, 'Internet');
  assert.equal(inst.data.finalCategoryId, child);
});

test('nothing dirty → no-op', async () => {
  const inst = fakeInstance({ finalCategory: 'Internet', finalCategoryId: child }, new Set());
  await reconcileCategoryField({ instance: inst, householdId, strField: 'finalCategory', idField: 'finalCategoryId' });
  assert.equal(inst.data.finalCategory, 'Internet');
  assert.equal(inst.data.finalCategoryId, child);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH tsx --import ./test/setup.ts --test src/categories/reconcileCategoryField.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// backend/src/categories/reconcileCategoryField.ts
import type { Transaction } from 'sequelize';
import { Category } from '../models/Category';
import { resolveCategoryIdByName } from './resolveCategoryId';

interface FieldInstance {
  changed(f: string): boolean;
  get(f: string): unknown;
  set(f: string, v: unknown): void;
}

/**
 * Id-authoritative reconciliation of one (string, id) category pair on a model
 * instance, for a beforeSave hook:
 *  - if the id field changed → the id wins; derive the string mirror from the
 *    referenced node's leaf name (null id → null string). Do not re-resolve.
 *  - else if the string field changed → resolve it to a ROOT category id
 *    (legacy create-by-name path).
 *  - else → no-op.
 */
export async function reconcileCategoryField(opts: {
  instance: FieldInstance;
  householdId: number;
  strField: string;
  idField: string;
  transaction?: Transaction;
}): Promise<void> {
  const { instance, householdId, strField, idField, transaction } = opts;
  if (instance.changed(idField)) {
    const id = instance.get(idField) as number | null;
    if (id == null) {
      instance.set(strField, null);
      return;
    }
    const node = await Category.findOne({ where: { id, householdId }, transaction });
    instance.set(strField, node ? node.name : null);
    return;
  }
  if (instance.changed(strField)) {
    const str = instance.get(strField) as string | null;
    instance.set(idField, await resolveCategoryIdByName(householdId, str, { transaction }));
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH tsx --import ./test/setup.ts --test src/categories/reconcileCategoryField.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH \
git add backend/src/categories/reconcileCategoryField.ts backend/src/categories/reconcileCategoryField.test.ts && \
git commit -m "feat(categories): add id-authoritative reconcileCategoryField helper"
```

---

### Task 2: `Transaction` beforeSave uses the helper (3 fields)

**Files:**
- Modify: `backend/src/models/Transaction.ts` (hook ~398-405)
- Test: `backend/src/models/Transaction.idAuthoritative.test.ts`

**Interfaces:**
- Consumes: `reconcileCategoryField` (Task 1).
- Produces: the Transaction `beforeSave` hook reconciles all three pairs (`autoCategory`/`autoCategoryId`, `categoryOverride`/`categoryOverrideId`, `finalCategory`/`finalCategoryId`) id-authoritatively. A transaction created/updated with an explicit `finalCategoryId` pointing at a child node keeps it (string derived); a string-only write still resolves to a root.

- [ ] **Step 1: Write the failing test**

```ts
// backend/src/models/Transaction.idAuthoritative.test.ts
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { sequelize } from '../db';
import { Transaction, Household, Category, Account } from '../models';

let householdId: number, accountId: number, work: number, child: number;
beforeEach(async () => {
  await sequelize.sync({ force: true });
  householdId = (await Household.create({ name: 'T' })).id;
  accountId = (await Account.create({ householdId, name: 'A', type: 'chequing', currency: 'CAD' })).id;
  work = (await Category.create({ householdId, name: 'Work', icon: null, parentId: null })).id;
  child = (await Category.create({ householdId, name: 'Internet', icon: null, parentId: work })).id;
});

test('explicit child finalCategoryId sticks and is NOT clobbered to a root', async () => {
  const t = await Transaction.create({
    householdId, accountId, date: '2026-01-01', amount: -10, currency: 'CAD',
    descriptionRaw: 'x', finalCategoryId: child,
  } as never);
  assert.equal(t.finalCategoryId, child);     // not re-resolved to a root
  assert.equal(t.finalCategory, 'Internet');  // string derived from the node
  // re-save (simulating a later edit) must not clobber the child id
  t.set('notes', 'edited');
  await t.save();
  await t.reload();
  assert.equal(t.finalCategoryId, child);
});

test('string-only finalCategory still resolves to a ROOT id', async () => {
  const t = await Transaction.create({
    householdId, accountId, date: '2026-01-01', amount: -5, currency: 'CAD',
    descriptionRaw: 'y', finalCategory: 'Groceries',
  } as never);
  const node = await Category.findByPk(t.finalCategoryId!);
  assert.equal(node?.name, 'Groceries');
  assert.equal(node?.parentId, null);
});
```

> Adjust `Account.create`/`Transaction.create` to the real required fields (read the models). Keep the category assertions.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH tsx --import ./test/setup.ts --test src/models/Transaction.idAuthoritative.test.ts`
Expected: FAIL — the current hook re-resolves `finalCategory` (null/root) and clobbers the child id.

- [ ] **Step 3: Write minimal implementation**

Replace the Transaction `beforeSave` hook body (the block resolving the three ids) with:

```ts
  Transaction.addHook('beforeSave', async (instance: Transaction, options) => {
    if (instance.householdId == null) return;
    const { reconcileCategoryField } = await import('../categories/reconcileCategoryField');
    const tx = options.transaction ?? undefined;
    const hh = instance.householdId;
    await reconcileCategoryField({ instance, householdId: hh, strField: 'autoCategory', idField: 'autoCategoryId', transaction: tx });
    await reconcileCategoryField({ instance, householdId: hh, strField: 'categoryOverride', idField: 'categoryOverrideId', transaction: tx });
    await reconcileCategoryField({ instance, householdId: hh, strField: 'finalCategory', idField: 'finalCategoryId', transaction: tx });
  });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH tsx --import ./test/setup.ts --test src/models/Transaction.idAuthoritative.test.ts`
Expected: PASS (2 tests). Then run `src/models/Transaction.categoryId.test.ts` (B1's test) + `src/models.test.ts` to confirm no regression, + typecheck.

- [ ] **Step 5: Commit**

```bash
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH \
git add backend/src/models/Transaction.ts backend/src/models/Transaction.idAuthoritative.test.ts && \
git commit -m "feat(categories): Transaction beforeSave is id-authoritative via reconcileCategoryField"
```

---

### Task 3: `Rule` + `BudgetTarget` beforeSave use the helper

**Files:**
- Modify: `backend/src/models/Rule.ts` (hook ~104-110), `backend/src/models/BudgetTarget.ts` (hook ~148-154)
- Test: `backend/src/models/ruleBudget.idAuthoritative.test.ts`

**Interfaces:**
- Consumes: `reconcileCategoryField` (Task 1).
- Produces: both hooks reconcile their `category`/`categoryId` pair id-authoritatively (an explicit child `categoryId` sticks; string-only resolves to root).

- [ ] **Step 1: Write the failing test**

```ts
// backend/src/models/ruleBudget.idAuthoritative.test.ts
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { sequelize } from '../db';
import { Rule, BudgetTarget, Household, Category } from '../models';

let householdId: number, child: number;
beforeEach(async () => {
  await sequelize.sync({ force: true });
  householdId = (await Household.create({ name: 'T' })).id;
  const work = await Category.create({ householdId, name: 'Work', icon: null, parentId: null });
  child = (await Category.create({ householdId, name: 'Internet', icon: null, parentId: work.id })).id;
});

test('Rule explicit child categoryId sticks + derives string', async () => {
  const r = await Rule.create({ householdId, categoryId: child } as never);
  assert.equal(r.categoryId, child);
  assert.equal(r.category, 'Internet');
});

test('BudgetTarget explicit child categoryId sticks + derives string', async () => {
  const b = await BudgetTarget.create({ householdId, categoryId: child } as never);
  assert.equal(b.categoryId, child);
  assert.equal(b.category, 'Internet');
});
```

> Add the minimal required fields each model needs (read them).

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH tsx --import ./test/setup.ts --test src/models/ruleBudget.idAuthoritative.test.ts`
Expected: FAIL — current hooks re-resolve `category` (null → null id), clobbering the child id.

- [ ] **Step 3: Write minimal implementation**

In `Rule.ts`, replace the `beforeSave` hook body with:
```ts
  Rule.addHook('beforeSave', async (instance: Rule, options) => {
    if (instance.householdId == null) return;
    const { reconcileCategoryField } = await import('../categories/reconcileCategoryField');
    await reconcileCategoryField({
      instance, householdId: instance.householdId,
      strField: 'category', idField: 'categoryId',
      transaction: options.transaction ?? undefined,
    });
  });
```
In `BudgetTarget.ts`, the identical pattern (referencing `BudgetTarget`/`instance`).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH tsx --import ./test/setup.ts --test src/models/ruleBudget.idAuthoritative.test.ts`
Expected: PASS (2). Then run B1's `src/models/ruleBudgetCategoryId.test.ts` (no regression) + typecheck.

- [ ] **Step 5: Commit**

```bash
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH \
git add backend/src/models/Rule.ts backend/src/models/BudgetTarget.ts backend/src/models/ruleBudget.idAuthoritative.test.ts && \
git commit -m "feat(categories): Rule + BudgetTarget beforeSave id-authoritative"
```

---

### Task 4: `ExternalOrderItem` beforeSave uses the helper

**Files:**
- Modify: `backend/src/models/ExternalOrderItem.ts` (hook ~98-106)
- Test: `backend/src/models/externalOrderItem.idAuthoritative.test.ts`

**Interfaces:**
- Consumes: `reconcileCategoryField` (Task 1).
- Produces: the item hook resolves the household via the parent `ExternalOrder` (unchanged), then reconciles `inferredCategory`/`inferredCategoryId` and `categoryOverride`/`categoryOverrideId` id-authoritatively. Missing order/household → leave untouched (no throw), as before.

- [ ] **Step 1: Write the failing test**

```ts
// backend/src/models/externalOrderItem.idAuthoritative.test.ts
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { sequelize } from '../db';
import { ExternalOrder, ExternalOrderItem, Household, Category } from '../models';

let householdId: number, orderId: number, child: number;
beforeEach(async () => {
  await sequelize.sync({ force: true });
  householdId = (await Household.create({ name: 'T' })).id;
  orderId = (await ExternalOrder.create({ householdId, vendor: 'amazon', source: 'amazon', currency: 'CAD' } as never)).id;
  const work = await Category.create({ householdId, name: 'Work', icon: null, parentId: null });
  child = (await Category.create({ householdId, name: 'Internet', icon: null, parentId: work.id })).id;
});

test('explicit child categoryOverrideId sticks + derives string', async () => {
  const item = await ExternalOrderItem.create({ externalOrderId: orderId, title: 'X', categoryOverrideId: child } as never);
  assert.equal(item.categoryOverrideId, child);
  assert.equal(item.categoryOverride, 'Internet');
});
```

> Adjust create() fields to the real models.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH tsx --import ./test/setup.ts --test src/models/externalOrderItem.idAuthoritative.test.ts`
Expected: FAIL — current hook re-resolves the string, clobbering the id.

- [ ] **Step 3: Write minimal implementation**

Replace the `ExternalOrderItem` `beforeSave` hook body:
```ts
  ExternalOrderItem.addHook('beforeSave', async (instance: ExternalOrderItem, options) => {
    const tx = options.transaction ?? undefined;
    const { ExternalOrder } = await import('./ExternalOrder');
    const order = await ExternalOrder.findByPk(instance.externalOrderId, { transaction: tx });
    if (!order || order.householdId == null) return;
    const { reconcileCategoryField } = await import('../categories/reconcileCategoryField');
    await reconcileCategoryField({ instance, householdId: order.householdId, strField: 'inferredCategory', idField: 'inferredCategoryId', transaction: tx });
    await reconcileCategoryField({ instance, householdId: order.householdId, strField: 'categoryOverride', idField: 'categoryOverrideId', transaction: tx });
  });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH tsx --import ./test/setup.ts --test src/models/externalOrderItem.idAuthoritative.test.ts`
Expected: PASS. Then run B1's `src/models/externalOrderItemCategoryId.test.ts` (no regression) + typecheck.

- [ ] **Step 5: Commit**

```bash
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH \
git add backend/src/models/ExternalOrderItem.ts backend/src/models/externalOrderItem.idAuthoritative.test.ts && \
git commit -m "feat(categories): ExternalOrderItem beforeSave id-authoritative"
```

---

### Task 5: Transaction PATCH accepts `categoryOverrideId`

**Files:**
- Modify: `backend/src/routes/transactions.ts` (`PATCHABLE_KEYS` ~407-420; `applyPatchBody` ~445-536)
- Test: `backend/test/integration/transactionCategoryId.test.ts` (Postgres)

**Interfaces:**
- Consumes: the id-authoritative hook (Task 2).
- Produces: `applyPatchBody` accepts `categoryOverrideId` (a number or null). When present, it sets `txn.categoryOverrideId` AND `txn.finalCategoryId` to the same value (the override is the winner for the final reporting category) — the id-authoritative beforeSave then derives both string mirrors from the node. A household-ownership check rejects an id from another household with 400. The existing string `categoryOverride` key still works (legacy).

- [ ] **Step 1: Write the failing test**

```ts
// backend/test/integration/transactionCategoryId.test.ts
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { setupPgTestDb, teardownPgTestDb, type PgTestDb } from './_setup/pgTestDb.js';

let app: import('express').Express; let authed: ReturnType<typeof request.agent>; let testDb: PgTestDb;
before(async () => {
  testDb = await setupPgTestDb('txn-categoryid');
  app = (await import('../../src/app.js')).default;
  authed = request.agent(app);
  await authed.post('/api/auth/register').send({ email: 'tc@example.com', displayName: 'T', password: 'password123' });
});
after(async () => { await teardownPgTestDb(testDb); });

test('PATCH categoryOverrideId tags the txn to a child node and finalCategoryId follows', async () => {
  const work = await authed.post('/api/categories').send({ name: 'Work', parentId: null });
  const internet = await authed.post('/api/categories').send({ name: 'Internet', parentId: work.body.id });
  // create an account + a transaction via the real endpoints (read an existing integration test for the seed pattern)
  // ... seed `txnId` ...
  const res = await authed.patch(`/api/transactions/${txnId}`).send({ categoryOverrideId: internet.body.id });
  assert.equal(res.status, 200);
  assert.equal(res.body.categoryOverrideId, internet.body.id);
  assert.equal(res.body.finalCategoryId, internet.body.id);
  assert.equal(res.body.finalCategory, 'Internet');
});

test('rejects a categoryOverrideId from another household', async () => {
  // create a second household + category via the model layer (see aiInbox.test.ts pattern), then PATCH with its id → 400
});
```

> This needs a seeded account+transaction. Read `backend/test/integration/transactionReceiptsWithItems.test.ts` / `aiInbox.test.ts` for the seed + second-household patterns; fill `txnId`. Keep the categoryOverrideId assertions.

- [ ] **Step 2: Run test to verify it fails**

Run (Postgres up): `cd backend && PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH yarn run test:integration --test-name-pattern 'categoryOverrideId tags'`
Expected: FAIL — `categoryOverrideId` ignored (not in PATCHABLE_KEYS).

- [ ] **Step 3: Write minimal implementation**

In `backend/src/routes/transactions.ts`:
1. Add `'categoryOverrideId'` to `PATCHABLE_KEYS`.
2. In `applyPatchBody`, add a branch before the generic `else`:
```ts
      } else if (k === 'categoryOverrideId') {
        if (b[k] == null) {
          txn.set('categoryOverrideId', null);
          txn.set('finalCategoryId', null);
        } else {
          const catId = Number(b[k]);
          const cat = await Category.findOne({ where: { id: catId, householdId: household.id } });
          if (!cat) {
            const err = new Error('categoryOverrideId must reference a household category') as Error & { status?: number };
            err.status = 400;
            throw err;
          }
          txn.set('categoryOverrideId', cat.id);
          txn.set('finalCategoryId', cat.id); // override wins for the final reporting category
        }
```
3. Import `Category` (from `../models`) at the top if not already imported.

> The id-authoritative `beforeSave` hook (Task 2) then derives `categoryOverride` + `finalCategory` strings from the node, and leaves the ids intact. No need to set the strings here.

- [ ] **Step 4: Run the test**

Run (Postgres up): `cd backend && PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH yarn run test:integration --test-name-pattern 'categoryOverrideId'`
Expected: PASS. Then typecheck + lint.

- [ ] **Step 5: Commit**

```bash
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH \
git add backend/src/routes/transactions.ts backend/test/integration/transactionCategoryId.test.ts && \
git commit -m "feat(categories): transaction PATCH accepts categoryOverrideId (child tagging)"
```

---

### Task 6: `syncCategoryLeafNameMirrors` service

**Files:**
- Create: `backend/src/categories/syncMirrors.ts`
- Test: `backend/src/categories/syncMirrors.test.ts`

**Interfaces:**
- Consumes: `Transaction`, `ExternalOrderItem`, `Rule`, `BudgetTarget` models.
- Produces: `syncCategoryLeafNameMirrors(categoryId: number, newLeafName: string, transaction: import('sequelize').Transaction): Promise<void>` — sets the string mirror = `newLeafName` on every row referencing `categoryId`: `Transaction.{autoCategory WHERE autoCategoryId=id, categoryOverride WHERE categoryOverrideId=id, finalCategory WHERE finalCategoryId=id}`, `ExternalOrderItem.{inferredCategory WHERE inferredCategoryId=id, categoryOverride WHERE categoryOverrideId=id}`, `Rule.category WHERE categoryId=id`, `BudgetTarget.category WHERE categoryId=id`. Uses `Model.update(..., {where, transaction})`.

- [ ] **Step 1: Write the failing test**

```ts
// backend/src/categories/syncMirrors.test.ts
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { sequelize } from '../db';
import { Category, Household, Account, Transaction, Rule, BudgetTarget } from '../models';
import { syncCategoryLeafNameMirrors } from './syncMirrors';

let householdId: number, accountId: number, catId: number;
beforeEach(async () => {
  await sequelize.sync({ force: true });
  householdId = (await Household.create({ name: 'T' })).id;
  accountId = (await Account.create({ householdId, name: 'A', type: 'chequing', currency: 'CAD' })).id;
  catId = (await Category.create({ householdId, name: 'Internet', icon: null, parentId: null })).id;
});

test('fans the new leaf name out to all string mirrors referencing the id', async () => {
  const t = await Transaction.create({ householdId, accountId, date: '2026-01-01', amount: -5, currency: 'CAD', descriptionRaw: 'x', finalCategoryId: catId } as never);
  const r = await Rule.create({ householdId, categoryId: catId } as never);
  const b = await BudgetTarget.create({ householdId, categoryId: catId } as never);
  assert.equal(t.finalCategory, 'Internet'); // derived by hook
  await sequelize.transaction(async (tx) => {
    await Category.update({ name: 'WiFi', nameKey: 'wifi' }, { where: { id: catId }, transaction: tx });
    await syncCategoryLeafNameMirrors(catId, 'WiFi', tx);
  });
  await t.reload(); await r.reload(); await b.reload();
  assert.equal(t.finalCategory, 'WiFi');
  assert.equal(r.category, 'WiFi');
  assert.equal(b.category, 'WiFi');
});
```

> Adjust create() required fields to the real models.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH tsx --import ./test/setup.ts --test src/categories/syncMirrors.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// backend/src/categories/syncMirrors.ts
import type { Transaction as SequelizeTransaction } from 'sequelize';
import { Transaction, ExternalOrderItem, Rule, BudgetTarget } from '../models';

/**
 * Fan a renamed category's new leaf name out to every denormalized string mirror
 * that references the node id. Call inside the rename transaction.
 */
export async function syncCategoryLeafNameMirrors(
  categoryId: number,
  newLeafName: string,
  transaction: SequelizeTransaction,
): Promise<void> {
  await Promise.all([
    Transaction.update({ autoCategory: newLeafName }, { where: { autoCategoryId: categoryId }, transaction }),
    Transaction.update({ categoryOverride: newLeafName }, { where: { categoryOverrideId: categoryId }, transaction }),
    Transaction.update({ finalCategory: newLeafName }, { where: { finalCategoryId: categoryId }, transaction }),
    ExternalOrderItem.update({ inferredCategory: newLeafName }, { where: { inferredCategoryId: categoryId }, transaction }),
    ExternalOrderItem.update({ categoryOverride: newLeafName }, { where: { categoryOverrideId: categoryId }, transaction }),
    Rule.update({ category: newLeafName }, { where: { categoryId }, transaction }),
    BudgetTarget.update({ category: newLeafName }, { where: { categoryId }, transaction }),
  ]);
}
```

> `Model.update(...)` is a static call — it does NOT fire the `beforeSave` instance hooks, which is exactly what we want here (no id re-resolution, just a string mirror set).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH tsx --import ./test/setup.ts --test src/categories/syncMirrors.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH \
git add backend/src/categories/syncMirrors.ts backend/src/categories/syncMirrors.test.ts && \
git commit -m "feat(categories): add syncCategoryLeafNameMirrors service"
```

---

### Task 7: `PATCH /api/categories/:id` name-rename

**Files:**
- Modify: `backend/src/routes/categories.ts` (`PATCH /:id` ~125-162)
- Test: `backend/test/integration/categoryRename.test.ts` (Postgres)

**Interfaces:**
- Consumes: `syncCategoryLeafNameMirrors` (Task 6), `normalizeCategoryName`, `Category`, `CategoryError`.
- Produces: `PATCH /api/categories/:id` accepts an additional `name` field. When `name` is present: validate non-empty; compute `nameKey`; reject `sibling_conflict` (409) if another sibling under the same `parentId` has that `nameKey`; update `name` + `nameKey` and call `syncCategoryLeafNameMirrors(id, name, tx)` — all in ONE transaction. icon/taxTreatment still work; the "icon or taxTreatment required" 400 becomes "name, icon, or taxTreatment required".

- [ ] **Step 1: Write the failing test**

```ts
// backend/test/integration/categoryRename.test.ts
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { setupPgTestDb, teardownPgTestDb, type PgTestDb } from './_setup/pgTestDb.js';

let app: import('express').Express; let authed: ReturnType<typeof request.agent>; let testDb: PgTestDb;
before(async () => {
  testDb = await setupPgTestDb('category-rename');
  app = (await import('../../src/app.js')).default;
  authed = request.agent(app);
  await authed.post('/api/auth/register').send({ email: 'cr@example.com', displayName: 'C', password: 'password123' });
});
after(async () => { await teardownPgTestDb(testDb); });

test('rename updates the node and is rejected on sibling conflict', async () => {
  const work = await authed.post('/api/categories').send({ name: 'Work', parentId: null });
  const internet = await authed.post('/api/categories').send({ name: 'Internet', parentId: work.body.id });
  await authed.post('/api/categories').send({ name: 'Phone', parentId: work.body.id });

  const ok = await authed.patch(`/api/categories/${internet.body.id}`).send({ name: 'WiFi' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.name, 'WiFi');

  const conflict = await authed.patch(`/api/categories/${internet.body.id}`).send({ name: 'Phone' });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.code, 'sibling_conflict');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (Postgres up): `cd backend && PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH yarn run test:integration --test-name-pattern 'rename updates the node'`
Expected: FAIL — `name` ignored; rename returns the unchanged node / 400.

- [ ] **Step 3: Write minimal implementation**

In `backend/src/routes/categories.ts` `PATCH /:id`, add (imports: `normalizeCategoryName` from `../categories/normalizeName`, `syncCategoryLeafNameMirrors` from `../categories/syncMirrors`, `Op` from `sequelize`, `sequelize` from `../db`):
- Change the required-field guard to accept `name` too: `const hasName = 'name' in b; if (!hasName && !hasIcon && !hasTreatment) { res.status(400).json({ error: 'name, icon, or taxTreatment required' }); return; }`
- Add, before `await row.save()`:
```ts
    if (hasName) {
      if (typeof b.name !== 'string' || b.name.trim().length === 0) {
        res.status(400).json({ error: 'name required' });
        return;
      }
      const newName = b.name.trim();
      const newKey = normalizeCategoryName(newName);
      const conflict = await Category.findOne({
        where: { householdId: row.householdId, parentId: row.parentId, nameKey: newKey, id: { [Op.ne]: row.id } },
      });
      if (conflict) {
        res.status(409).json({ error: `a sibling named "${newName}" already exists`, code: 'sibling_conflict' });
        return;
      }
      await sequelize.transaction(async (tx) => {
        row.set('name', newName);
        row.set('nameKey', newKey);
        // also apply any icon/taxTreatment set above, then save in-tx
        await row.save({ transaction: tx });
        await syncCategoryLeafNameMirrors(row.id, newName, tx);
      });
      res.json(row);
      return;
    }
```
Keep the existing icon/taxTreatment path for the no-name case (`await row.save(); res.json(row);`). Ensure icon/taxTreatment provided alongside `name` are applied inside the transaction (set them before the `row.save({transaction})`).

> Use `currentAuth(req)` is unnecessary here — `row` is already household-scoped via `householdWhere(req)` in the initial `findOne`.

- [ ] **Step 4: Run the test**

Run (Postgres up): `cd backend && PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH yarn run test:integration --test-name-pattern 'rename updates the node'`
Expected: PASS. Then typecheck + lint.

- [ ] **Step 5: Commit**

```bash
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH \
git add backend/src/routes/categories.ts backend/test/integration/categoryRename.test.ts && \
git commit -m "feat(categories): PATCH /categories/:id name-rename with mirror sync + sibling-conflict"
```

---

## Final verification

- [ ] Full backend unit suite green: `cd backend && PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH yarn workspace cashflow-backend run test` → `# fail 0`.
- [ ] Integration (Postgres): the new transactionCategoryId + categoryRename tests pass.
- [ ] **fallow: no new import cycles** (`yarn fallow dead-code` — the new `categories/*` files import `../models/Category` directly, NOT the barrel) and **jscpd ratchet**: the four hooks now share `reconcileCategoryField` (no copy-paste duplication).
- [ ] Typecheck + lint clean.

## What Plan C1 leaves to Plan C2 (frontend)

- Category **picker** path-syntax (`Work / Expenses / Internet`) + full-path suggestion display; on select, call `POST /api/categories/resolve-path` then PATCH the transaction's `categoryOverrideId`.
- Category **manager page**: tree view, create, **rename** (uses this PATCH), drag-to-reparent (cycle vs sibling-conflict — two distinct errors), delete-block messaging.
- Render B2's per-currency `categoryTree` rollup (collapsed parent totals, expand to children) in dashboard/monthly/sankey category views.
- AI suggestion deferred (accept-time) path creation.
