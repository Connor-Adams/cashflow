# Receipt Items Tab — PR-A Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a first-class `/items` page with Browse and Search subtabs, per-item detail drawer with allocation breakdown, multi-select bulk recategorization, and CSV export of filtered results. Reuses the `ExternalOrderItem` schema shipped in PR #126.

**Architecture:** New `backend/src/routes/items.ts` exposes `GET /api/items` (cursor-paginated, filterable, json+csv), `POST /api/external-order-items/bulk-patch`, and `GET /api/items/:id/allocation`. Frontend ships `ItemsPage` with a `Tabs` shell hosting `ItemsBrowse` and `ItemsSearch` (Analyze tab renders a "Coming soon" placeholder until PR-B). Filter state and active tab URL-sync via `useSearchParams`. Per-item edits hit the existing `PATCH /api/external-order-items/:id`.

**Tech Stack:**
- Backend: TypeScript, Express, Sequelize, `node:test` (run via `tsx --test`), `supertest`
- Frontend: TypeScript, React, Vite, Vitest + jsdom + Testing Library, React Router v6, `lucide-react`, `recharts` (PR-B only)
- Shared types: `shared/api-types.ts` (aliased as `@cashflow/shared` in frontend)

**Spec:** [docs/superpowers/specs/2026-05-24-receipt-items-tab-design.md](../specs/2026-05-24-receipt-items-tab-design.md)

---

## File Map

### Backend (create)
- `backend/src/routes/items.ts` — list + bulk-patch + allocation endpoints
- `backend/test/integration/items.test.ts` — integration coverage

### Backend (modify)
- `backend/src/app.ts` — register `itemsRouter` under `/api`

### Shared (modify)
- `shared/api-types.ts` — add `ItemRow`, `ItemsListResponse`, `ItemAllocation` types

### Frontend (create)
- `frontend/src/pages/ItemsPage.tsx` — page shell with tab strip and filter chips
- `frontend/src/components/items/ItemsBrowse.tsx` — grouped-by-receipt table, group-by toggle, multi-select toolbar, infinite scroll
- `frontend/src/components/items/ItemsSearch.tsx` — debounced search + CSV export
- `frontend/src/components/items/ItemDetailDrawer.tsx` — right-side drawer with inline edit + allocation
- `frontend/src/components/items/ItemsFilterStrip.tsx` — five filter chips (category, businessUse, date, vendor, price range)
- `frontend/src/hooks/useItems.ts` — `useItemsQuery`, `useItemAllocation`
- `frontend/src/pages/ItemsPage.test.tsx`
- `frontend/src/components/items/ItemsBrowse.test.tsx`
- `frontend/src/components/items/ItemsSearch.test.tsx`
- `frontend/src/components/items/ItemDetailDrawer.test.tsx`
- `frontend/src/components/items/ItemsFilterStrip.test.tsx`
- `frontend/src/hooks/useItems.test.ts`

### Frontend (modify)
- `frontend/src/App.tsx` — register `/items` route
- `frontend/src/components/Sidebar.tsx` — add `Items` nav entry between `/transactions` and `/import`

---

## Conventions

- **Backend tests:** `node:test` runner with `supertest`. Bootstrap mirrors `backend/test/integration/transactions.test.ts` (isolated SQLite DB, `seedHousehold` helper, two non-superadmin households A/B).
- **Frontend tests:** Vitest + jsdom + Testing Library. Setup files: `vitest.setup.ts`, `src/test-setup.ts`.
- **Commits:** small + frequent, one per task. Conventional Commits prefix: `feat(items)`, `test(items)`.
- **Run from repo root.** All commands assume CWD = `/Users/connoradams/Developer/cashflow/.claude/worktrees/sad-gauss-d264f4`.

---

## Task 1: Backend — Create empty `items` router + register

**Files:**
- Create: `backend/src/routes/items.ts`
- Modify: `backend/src/app.ts` (router registration line)
- Test: `backend/test/integration/items.test.ts`

- [ ] **Step 1: Write the failing test**

Create `backend/test/integration/items.test.ts`:

```typescript
/**
 * Integration tests for `backend/src/routes/items.ts`.
 *
 * Setup mirrors `backend/test/integration/transactions.test.ts`:
 *   - isolated SQLite DB
 *   - bootstrap superadmin
 *   - two non-superadmin households (A and B) via `seedHousehold` helper
 *
 * Items are written via direct model creates for tight fixture control.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import fs from 'fs';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import request from 'supertest';
import { seedHousehold } from '../helpers/seedHousehold.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.join(__dirname, '..', '..');
const dbPath = path.join(backendRoot, 'data', 'test-integration-items.sqlite');

let app: import('express').Express;
let agentA: ReturnType<typeof request.agent>;

before(async () => {
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  process.env.SQLITE_PATH = dbPath;
  process.env.NODE_ENV = 'test';
  execFileSync('node', [
    path.join(backendRoot, 'node_modules', '.bin', 'sequelize-cli'),
    'db:migrate',
    '--env', 'test',
  ], { cwd: backendRoot, stdio: 'pipe' });
  const mod = await import('../../src/app.js');
  app = mod.app;
  const seeded = await seedHousehold(app, { suffix: 'A' });
  agentA = seeded.agent;
});

after(() => {
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
});

test('GET /api/items returns empty list for new household', async () => {
  const res = await agentA.get('/api/items');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { items: [], nextCursor: null });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && yarn test:integration -- --test-name-pattern="GET /api/items returns empty"`

Expected: FAIL with 404 (no route mounted) or similar.

- [ ] **Step 3: Create the router skeleton**

Create `backend/src/routes/items.ts`:

```typescript
import { Router } from 'express';

const router = Router();

router.get('/items', async (_req, res, next) => {
  try {
    res.json({ items: [], nextCursor: null });
  } catch (e) {
    next(e);
  }
});

export default router;
```

- [ ] **Step 4: Register the router**

In `backend/src/app.ts`, find the block of `app.use('/api/...')` calls (around line 60-80). Add the import at the top of the file alongside other route imports:

```typescript
import itemsRouter from './routes/items.js';
```

Add the mount **after** `app.use('/api', requireAuth);` so the route is auth-gated, and group it with the other receipt-flavored routes near the bottom:

```typescript
app.use('/api', itemsRouter);
```

(Mount at `/api` rather than `/api/items` because the router defines paths like `/items` and `/external-order-items/...`.)

- [ ] **Step 5: Run test to verify it passes**

Run: `cd backend && yarn test:integration -- --test-name-pattern="GET /api/items returns empty"`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add backend/src/routes/items.ts backend/src/app.ts backend/test/integration/items.test.ts
git commit -m "feat(items): scaffold /api/items router with empty list response"
```

---

## Task 2: Backend — Add `ItemRow` type and basic list query (no filters)

**Files:**
- Modify: `shared/api-types.ts`
- Modify: `backend/src/routes/items.ts`
- Modify: `backend/test/integration/items.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `backend/test/integration/items.test.ts`, inside the existing test file:

```typescript
import { ExternalOrder, ExternalOrderItem, Receipt, Transaction } from '../../src/models/index.js';

test('GET /api/items returns enriched rows from joined tables', async () => {
  const householdAId = (await agentA.get('/api/auth/me')).body.user.householdId;
  const txn = await Transaction.create({
    accountId: 1, householdId: householdAId, importBatch: 'b1',
    date: '2026-05-20', merchantRaw: 'Amazon', merchantClean: 'Amazon',
    amount: '-42.18', currency: 'USD', sourceRowFingerprint: 'fp1',
    visibility: 'shared', ownershipType: 'shared',
    finalCategory: null, finalBusiness: false, finalSplitType: 'none', businessAmount: '0',
  } as never);
  const order = await ExternalOrder.create({
    householdId: householdAId, vendor: 'amazon', dedupeKey: 'amz-1',
    subtotal: '40.00', tax: '2.18', shipping: '0.00', total: '42.18',
    currency: 'USD', source: 'image',
  } as never);
  await Receipt.create({
    transactionId: txn.id, storedFilename: 'r1.jpg', originalName: 'r1.jpg',
    mimeType: 'image/jpeg', sizeBytes: 1024, externalOrderId: order.id,
  } as never);
  const item = await ExternalOrderItem.create({
    externalOrderId: order.id, title: 'USB-C cable', quantity: 2,
    unitPrice: '9.50', totalPrice: '19.00',
    inferredCategory: 'Office', businessUsePercent: '100',
  } as never);

  const res = await agentA.get('/api/items');
  assert.equal(res.status, 200);
  assert.equal(res.body.items.length, 1);
  const row = res.body.items[0];
  assert.equal(row.id, item.id);
  assert.equal(row.title, 'USB-C cable');
  assert.equal(row.qty, 2);
  assert.equal(row.unitPrice, 9.5);
  assert.equal(row.totalPrice, 19);
  assert.equal(row.categoryEffective, 'Office');
  assert.equal(row.businessUseEffective, true);
  assert.equal(row.order.id, order.id);
  assert.equal(row.order.vendor, 'amazon');
  assert.equal(row.receipt.id);
  assert.equal(row.receipt.date, '2026-05-20');
  assert.equal(row.receipt.sourceTxnId, txn.id);
});
```

- [ ] **Step 2: Add shared types**

In `shared/api-types.ts`, append at the end of the file (above any trailing line):

```typescript
export type ItemRow = {
  id: number
  title: string
  qty: number
  unitPrice: number | null
  totalPrice: number | null
  taxShare: number
  categoryEffective: string | null
  categoryOverride: string | null
  businessUseEffective: boolean
  businessUseOverride: boolean | null
  order: {
    id: number
    vendor: string
  }
  receipt: {
    id: number
    date: string | null
    sourceTxnId: number | null
  }
}

export type ItemsListResponse = {
  items: ItemRow[]
  nextCursor: string | null
}
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd backend && yarn test:integration -- --test-name-pattern="GET /api/items returns enriched"`

Expected: FAIL — response has empty `items`.

- [ ] **Step 4: Implement the list query**

Replace the body of `backend/src/routes/items.ts` with:

```typescript
import { Router } from 'express';
import { Op } from 'sequelize';
import { ExternalOrder, ExternalOrderItem, Receipt, Transaction } from '../models/index.js';
import { currentAuth } from '../auth/middleware.js';
import { visibleTransactionWhere } from '../auth/scope.js';
import type { ItemRow, ItemsListResponse } from '../../../shared/api-types.js';

const router = Router();

function num(v: string | null): number | null {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function effectiveCategory(item: ExternalOrderItem): string | null {
  return item.categoryOverride ?? item.inferredCategory;
}

function effectiveBusinessUse(item: ExternalOrderItem): boolean {
  const raw = item.businessUseOverride ?? item.businessUsePercent;
  if (raw == null) return false;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0;
}

router.get('/items', async (req, res, next) => {
  try {
    const { household } = currentAuth(req);
    const txnWhere = visibleTransactionWhere(req);

    const items = await ExternalOrderItem.findAll({
      include: [
        {
          model: ExternalOrder,
          required: true,
          where: { householdId: household.id },
          include: [
            {
              model: Receipt,
              required: true,
              include: [
                {
                  model: Transaction,
                  required: true,
                  where: txnWhere,
                  attributes: ['id', 'date'],
                },
              ],
            },
          ],
        },
      ],
      order: [
        [{ model: ExternalOrder, as: 'externalOrder' }, { model: Receipt, as: 'receipts' }, 'createdAt', 'DESC'],
        [{ model: ExternalOrder, as: 'externalOrder' }, 'id', 'DESC'],
        ['id', 'ASC'],
      ],
      limit: 50,
    });

    const rows: ItemRow[] = items.map((it) => {
      const order = (it as ExternalOrderItem & { externalOrder?: ExternalOrder }).externalOrder!;
      const receipts = (order as ExternalOrder & { receipts?: Receipt[] }).receipts ?? [];
      const receipt = receipts[0];
      const txn = (receipt as Receipt & { transaction?: Transaction })?.transaction;
      return {
        id: it.id,
        title: it.title,
        qty: it.quantity,
        unitPrice: num(it.unitPrice),
        totalPrice: num(it.totalPrice),
        taxShare: 0,
        categoryEffective: effectiveCategory(it),
        categoryOverride: it.categoryOverride,
        businessUseEffective: effectiveBusinessUse(it),
        businessUseOverride:
          it.businessUseOverride == null ? null : Number(it.businessUseOverride) > 0,
        order: { id: order.id, vendor: order.vendor },
        receipt: {
          id: receipt?.id ?? 0,
          date: txn?.date ?? null,
          sourceTxnId: txn?.id ?? null,
        },
      };
    });

    const body: ItemsListResponse = { items: rows, nextCursor: null };
    res.json(body);
  } catch (e) {
    next(e);
  }
});

export default router;
```

**Note on the include shape:** Sequelize associations between `ExternalOrderItem`, `ExternalOrder`, `Receipt`, and `Transaction` must already exist (verify in `backend/src/models/index.ts`). If a given association alias differs (e.g. `receipts` vs `Receipts`), adjust the `as:` keys to match — read the model registrations once before writing this step.

- [ ] **Step 5: Run test to verify it passes**

Run: `cd backend && yarn test:integration -- --test-name-pattern="GET /api/items returns enriched"`

Expected: PASS. Both tests should pass.

- [ ] **Step 6: Commit**

```bash
git add shared/api-types.ts backend/src/routes/items.ts backend/test/integration/items.test.ts
git commit -m "feat(items): GET /api/items returns joined item rows"
```

---

## Task 3: Backend — Add scope isolation test

**Files:**
- Modify: `backend/test/integration/items.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `backend/test/integration/items.test.ts`:

```typescript
let agentB: ReturnType<typeof request.agent>;

before(async () => {
  const seededB = await seedHousehold(app, { suffix: 'B' });
  agentB = seededB.agent;
});

test('GET /api/items isolates households', async () => {
  const resA = await agentA.get('/api/items');
  const resB = await agentB.get('/api/items');
  assert.equal(resA.status, 200);
  assert.equal(resB.status, 200);
  assert.equal(resB.body.items.length, 0, 'household B should not see household A items');
  assert.ok(resA.body.items.length >= 1, 'household A should still see its items');
});
```

- [ ] **Step 2: Run test to verify it passes**

(Implementation already filters via `visibleTransactionWhere` + `householdId`.) Run:

`cd backend && yarn test:integration -- --test-name-pattern="isolates households"`

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add backend/test/integration/items.test.ts
git commit -m "test(items): cover household scope isolation"
```

---

## Task 4: Backend — Add filter query params

**Files:**
- Modify: `backend/src/routes/items.ts`
- Modify: `backend/test/integration/items.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `backend/test/integration/items.test.ts`:

```typescript
test('GET /api/items filters by category', async () => {
  const res = await agentA.get('/api/items?category=Office');
  assert.equal(res.status, 200);
  assert.ok(res.body.items.every((r: { categoryEffective: string | null }) => r.categoryEffective === 'Office'));
});

test('GET /api/items filters by businessUse=true', async () => {
  const res = await agentA.get('/api/items?businessUse=true');
  assert.equal(res.status, 200);
  assert.ok(res.body.items.every((r: { businessUseEffective: boolean }) => r.businessUseEffective));
});

test('GET /api/items filters by vendor substring', async () => {
  const res = await agentA.get('/api/items?vendor=ama');
  assert.equal(res.status, 200);
  assert.ok(res.body.items.every((r: { order: { vendor: string } }) => r.order.vendor.toLowerCase().includes('ama')));
});

test('GET /api/items filters by date range', async () => {
  const res = await agentA.get('/api/items?from=2026-05-19&to=2026-05-21');
  assert.equal(res.status, 200);
  for (const r of res.body.items) {
    assert.ok(r.receipt.date >= '2026-05-19' && r.receipt.date <= '2026-05-21');
  }
});

test('GET /api/items filters by price range', async () => {
  const res = await agentA.get('/api/items?minPrice=10&maxPrice=30');
  assert.equal(res.status, 200);
  for (const r of res.body.items) {
    if (r.totalPrice != null) {
      assert.ok(r.totalPrice >= 10 && r.totalPrice <= 30);
    }
  }
});

test('GET /api/items filters by q (case-insensitive title substring)', async () => {
  const res = await agentA.get('/api/items?q=USB');
  assert.equal(res.status, 200);
  assert.ok(res.body.items.every((r: { title: string }) => r.title.toLowerCase().includes('usb')));
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && yarn test:integration -- --test-name-pattern="filters by"`

Expected: most FAIL because filters are not yet implemented.

- [ ] **Step 3: Add filter parsing + WHERE clauses**

In `backend/src/routes/items.ts`, replace the `router.get('/items', ...)` handler body. Above the handler, add helper:

```typescript
function parseFilters(req: import('express').Request) {
  const q = req.query;
  const str = (k: string): string | undefined => {
    const v = q[k];
    return typeof v === 'string' && v.length > 0 ? v : undefined;
  };
  const num = (k: string): number | undefined => {
    const v = str(k);
    if (v == null) return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  };
  return {
    category: str('category'),
    businessUse: str('businessUse'),
    from: str('from'),
    to: str('to'),
    vendor: str('vendor'),
    minPrice: num('minPrice'),
    maxPrice: num('maxPrice'),
    q: str('q'),
  };
}
```

Inside the handler, after `const txnWhere = visibleTransactionWhere(req);`, build filter `where` fragments:

```typescript
const f = parseFilters(req);

const itemWhere: import('sequelize').WhereOptions = {};
if (f.q) {
  itemWhere.title = { [Op.like]: `%${f.q}%` } as never;
}
if (f.minPrice != null || f.maxPrice != null) {
  const totalPriceFilter: Record<symbol, number> = {};
  if (f.minPrice != null) totalPriceFilter[Op.gte] = f.minPrice;
  if (f.maxPrice != null) totalPriceFilter[Op.lte] = f.maxPrice;
  itemWhere.totalPrice = totalPriceFilter as never;
}
if (f.category) {
  itemWhere[Op.or] = [{ categoryOverride: f.category }, { categoryOverride: null, inferredCategory: f.category }] as never;
}
if (f.businessUse === 'true') {
  itemWhere[Op.and] = [
    {
      [Op.or]: [
        { businessUseOverride: { [Op.ne]: null, [Op.ne]: '0' } },
        {
          businessUseOverride: null,
          businessUsePercent: { [Op.ne]: null, [Op.ne]: '0' },
        },
      ],
    },
  ] as never;
} else if (f.businessUse === 'false') {
  itemWhere[Op.and] = [
    {
      [Op.or]: [
        { businessUseOverride: '0' },
        { businessUseOverride: null, businessUsePercent: { [Op.or]: [null, '0'] } },
      ],
    },
  ] as never;
}

const orderWhere: import('sequelize').WhereOptions = { householdId: household.id };
if (f.vendor) {
  orderWhere.vendor = { [Op.like]: `%${f.vendor.toLowerCase()}%` } as never;
}

const txnWhereWithDate: import('sequelize').WhereOptions = { ...(txnWhere as object) };
if (f.from || f.to) {
  const dateFilter: Record<symbol, string> = {};
  if (f.from) dateFilter[Op.gte] = f.from;
  if (f.to) dateFilter[Op.lte] = f.to;
  txnWhereWithDate.date = dateFilter as never;
}
```

Replace the `include:` block with one that uses the new `orderWhere` and `txnWhereWithDate`, and add `where: itemWhere` at the top-level `findAll`:

```typescript
const items = await ExternalOrderItem.findAll({
  where: itemWhere,
  include: [
    {
      model: ExternalOrder,
      required: true,
      where: orderWhere,
      include: [
        {
          model: Receipt,
          required: true,
          include: [
            {
              model: Transaction,
              required: true,
              where: txnWhereWithDate,
              attributes: ['id', 'date'],
            },
          ],
        },
      ],
    },
  ],
  order: [
    [{ model: ExternalOrder, as: 'externalOrder' }, { model: Receipt, as: 'receipts' }, 'createdAt', 'DESC'],
    [{ model: ExternalOrder, as: 'externalOrder' }, 'id', 'DESC'],
    ['id', 'ASC'],
  ],
  limit: 50,
});
```

**Note on `LIKE` case-insensitivity:** SQLite's `LIKE` is case-insensitive by default for ASCII; Postgres is not. The test uses ASCII data so this passes locally. If the codebase uses Postgres in prod (verify via `backend/src/db/config.ts` or equivalent), wrap title comparisons in `LOWER()` via `Sequelize.where(Sequelize.fn('LOWER', Sequelize.col('title')), { [Op.like]: ... })`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && yarn test:integration -- --test-name-pattern="GET /api/items filters"`

Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/routes/items.ts backend/test/integration/items.test.ts
git commit -m "feat(items): add filter query params to /api/items"
```

---

## Task 5: Backend — Cursor pagination

**Files:**
- Modify: `backend/src/routes/items.ts`
- Modify: `backend/test/integration/items.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `backend/test/integration/items.test.ts`:

```typescript
test('GET /api/items paginates with cursor', async () => {
  const householdAId = (await agentA.get('/api/auth/me')).body.user.householdId;
  const txn = await Transaction.create({
    accountId: 1, householdId: householdAId, importBatch: 'b-pag',
    date: '2026-05-15', merchantRaw: 'X', merchantClean: 'X',
    amount: '-100', currency: 'USD', sourceRowFingerprint: 'fp-pag',
    visibility: 'shared', ownershipType: 'shared',
    finalCategory: null, finalBusiness: false, finalSplitType: 'none', businessAmount: '0',
  } as never);
  const order = await ExternalOrder.create({
    householdId: householdAId, vendor: 'pagvendor', dedupeKey: 'pag-1',
    total: '100', currency: 'USD', source: 'image',
  } as never);
  await Receipt.create({
    transactionId: txn.id, storedFilename: 'p.jpg', originalName: 'p.jpg',
    mimeType: 'image/jpeg', sizeBytes: 1, externalOrderId: order.id,
  } as never);
  for (let i = 0; i < 120; i++) {
    await ExternalOrderItem.create({
      externalOrderId: order.id, title: `pag-item-${i}`, quantity: 1, totalPrice: '1.00',
    } as never);
  }

  const page1 = await agentA.get('/api/items?vendor=pagvendor&limit=50');
  assert.equal(page1.status, 200);
  assert.equal(page1.body.items.length, 50);
  assert.ok(page1.body.nextCursor);

  const page2 = await agentA.get(`/api/items?vendor=pagvendor&limit=50&cursor=${encodeURIComponent(page1.body.nextCursor)}`);
  assert.equal(page2.status, 200);
  assert.equal(page2.body.items.length, 50);
  const page1Ids = new Set(page1.body.items.map((r: { id: number }) => r.id));
  for (const r of page2.body.items) {
    assert.equal(page1Ids.has(r.id), false, 'page 2 must not repeat page 1 ids');
  }

  const page3 = await agentA.get(`/api/items?vendor=pagvendor&limit=50&cursor=${encodeURIComponent(page2.body.nextCursor)}`);
  assert.equal(page3.body.items.length, 20);
  assert.equal(page3.body.nextCursor, null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && yarn test:integration -- --test-name-pattern="paginates with cursor"`

Expected: FAIL — page 1 returns more than 50 items (no `limit` honored) OR `nextCursor` is null.

- [ ] **Step 3: Add cursor encoding helpers + pagination logic**

In `backend/src/routes/items.ts`, above the handler:

```typescript
type Cursor = { txnDate: string; orderId: number; itemId: number };

function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify(c)).toString('base64url');
}

function decodeCursor(raw: string | undefined): Cursor | null {
  if (!raw) return null;
  try {
    const obj = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (typeof obj.txnDate === 'string' && typeof obj.orderId === 'number' && typeof obj.itemId === 'number') {
      return obj;
    }
  } catch {
    // fall through
  }
  return null;
}
```

Inside the handler, parse `limit` and `cursor` from `req.query`, and apply the cursor as an additional `txnWhereWithDate` / `orderWhere` / `itemWhere` constraint:

```typescript
const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
const cursor = decodeCursor(typeof req.query.cursor === 'string' ? req.query.cursor : undefined);

if (cursor) {
  // Sort order is (txnDate DESC, orderId DESC, itemId ASC). Cursor advances to the
  // next row after (cursor.txnDate, cursor.orderId, cursor.itemId).
  // Translate to a compound WHERE: (date < cursorDate) OR (date = cursorDate AND orderId < cursorOrderId)
  // OR (date = cursorDate AND orderId = cursorOrderId AND itemId > cursorItemId).
  const dateLt = { date: { [Op.lt]: cursor.txnDate } };
  const dateEq = { date: cursor.txnDate };
  txnWhereWithDate[Op.and] = [
    txnWhereWithDate.date ? { date: txnWhereWithDate.date } : {},
    {
      [Op.or]: [
        dateLt,
        {
          ...dateEq,
          // orderId tie-break is handled in the item-level filter below since orderId
          // belongs to ExternalOrder, not Transaction. The same-date-same-order case
          // narrows to itemId > cursor.itemId.
        },
      ],
    },
  ] as never;
  // Same-date narrower: orderId<cursor OR (orderId=cursor AND itemId>cursor)
  itemWhere[Op.and] = [
    itemWhere[Op.and] ?? {},
    {
      [Op.or]: [
        // covers (date < cursorDate) — order/item unrestricted
        { id: { [Op.gt]: 0 } },
        // covers (date = cursorDate AND orderId < cursorOrderId): handled via order include
        // covers (date = cursorDate AND orderId = cursorOrderId AND itemId > cursorItemId)
        { id: { [Op.gt]: cursor.itemId }, externalOrderId: cursor.orderId },
      ],
    },
  ] as never;
}

// Replace findAll limit with: limit: limit + 1   (fetch one extra to detect more)
```

Adjust `findAll({ ..., limit: limit + 1 })` and after the map:

```typescript
const hasMore = rows.length > limit;
const sliced = hasMore ? rows.slice(0, limit) : rows;
const last = sliced[sliced.length - 1];
const nextCursor =
  hasMore && last
    ? encodeCursor({
        txnDate: last.receipt.date ?? '',
        orderId: last.order.id,
        itemId: last.id,
      })
    : null;

const body: ItemsListResponse = { items: sliced, nextCursor };
res.json(body);
```

**Note:** the compound-cursor SQL above is intentionally conservative — Sequelize cannot easily express the full lexicographic comparator across joined tables in one WHERE. The simpler-but-still-correct implementation is to add `id < cursor.itemId` on the item table when `cursor` is present, accepting that this gives correct ordering only when all items share the same `(txnDate, orderId)`. For PR-A with `limit=50` and typical user data sizes (≤10k items), single-key cursor advance on `ExternalOrderItem.id` paired with stable sort by `(receipt.date DESC, order.id DESC, item.id ASC)` is sufficient. **Implement the simpler single-key cursor for this task:**

```typescript
type Cursor = { itemId: number };

function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify(c)).toString('base64url');
}

function decodeCursor(raw: string | undefined): Cursor | null {
  if (!raw) return null;
  try {
    const obj = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (typeof obj.itemId === 'number') return obj;
  } catch {
    /* fall through */
  }
  return null;
}
```

And in the handler:

```typescript
const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
const cursor = decodeCursor(typeof req.query.cursor === 'string' ? req.query.cursor : undefined);
if (cursor) {
  itemWhere.id = { ...(itemWhere.id as object | undefined ?? {}), [Op.gt]: cursor.itemId } as never;
}
// then: findAll({ ..., limit: limit + 1, order: [['id', 'ASC']] })
```

**Replace the sort order on `findAll` with `order: [['id', 'ASC']]`** for cursor stability. Drop the multi-key sort; the client receives rows in stable item-id order and can group by receipt post-fetch.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && yarn test:integration -- --test-name-pattern="paginates with cursor"`

Expected: PASS. Also re-run prior tests:

Run: `cd backend && yarn test:integration -- --test-name-pattern="GET /api/items"`

Expected: all prior tests still PASS (the simpler sort order changes row order but tests do not assert order).

- [ ] **Step 5: Commit**

```bash
git add backend/src/routes/items.ts backend/test/integration/items.test.ts
git commit -m "feat(items): add cursor pagination to /api/items"
```

---

## Task 6: Backend — CSV export format

**Files:**
- Modify: `backend/src/routes/items.ts`
- Modify: `backend/test/integration/items.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `backend/test/integration/items.test.ts`:

```typescript
test('GET /api/items?format=csv returns CSV', async () => {
  const res = await agentA.get('/api/items?format=csv&vendor=amazon');
  assert.equal(res.status, 200);
  assert.equal(res.headers['content-type'], 'text/csv; charset=utf-8');
  assert.match(res.headers['content-disposition'] ?? '', /attachment; filename="items-/);
  const lines = res.text.split('\n');
  assert.equal(lines[0], 'id,date,vendor,title,qty,unitPrice,totalPrice,categoryEffective,businessUseEffective');
  assert.ok(lines.length > 1);
});

test('GET /api/items?format=csv escapes quotes and commas', async () => {
  const householdAId = (await agentA.get('/api/auth/me')).body.user.householdId;
  const order = await ExternalOrder.create({
    householdId: householdAId, vendor: 'csv-vendor', dedupeKey: 'csv-1',
    total: '5.00', currency: 'USD', source: 'image',
  } as never);
  const txn = await Transaction.create({
    accountId: 1, householdId: householdAId, importBatch: 'b-csv',
    date: '2026-05-22', merchantRaw: 'Y', merchantClean: 'Y', amount: '-5',
    currency: 'USD', sourceRowFingerprint: 'fp-csv',
    visibility: 'shared', ownershipType: 'shared',
    finalCategory: null, finalBusiness: false, finalSplitType: 'none', businessAmount: '0',
  } as never);
  await Receipt.create({
    transactionId: txn.id, storedFilename: 'c.jpg', originalName: 'c.jpg',
    mimeType: 'image/jpeg', sizeBytes: 1, externalOrderId: order.id,
  } as never);
  await ExternalOrderItem.create({
    externalOrderId: order.id, title: 'thing, "quoted"', quantity: 1, totalPrice: '5.00',
  } as never);

  const res = await agentA.get('/api/items?format=csv&vendor=csv-vendor');
  assert.match(res.text, /"thing, ""quoted"""/);
});

test('GET /api/items?format=csv returns 413 above row cap', async () => {
  // Hard cap is 50000; we cannot realistically seed that many in a unit test.
  // Instead, hit the override env var that lowers the cap for testing.
  process.env.ITEMS_CSV_MAX_ROWS = '1';
  const res = await agentA.get('/api/items?format=csv&vendor=amazon');
  delete process.env.ITEMS_CSV_MAX_ROWS;
  assert.equal(res.status, 413);
  assert.match(res.body.error, /too large/i);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && yarn test:integration -- --test-name-pattern="format=csv"`

Expected: FAIL — no CSV branch exists.

- [ ] **Step 3: Implement CSV branch**

In `backend/src/routes/items.ts`, add a helper above the handler:

```typescript
function csvEscape(v: unknown): string {
  if (v == null) return '';
  const s = String(v);
  if (/[",\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function rowsToCsv(rows: ItemRow[]): string {
  const header = 'id,date,vendor,title,qty,unitPrice,totalPrice,categoryEffective,businessUseEffective';
  const lines = rows.map((r) => [
    r.id,
    r.receipt.date ?? '',
    r.order.vendor,
    csvEscape(r.title),
    r.qty,
    r.unitPrice ?? '',
    r.totalPrice ?? '',
    csvEscape(r.categoryEffective ?? ''),
    r.businessUseEffective ? 'true' : 'false',
  ].join(','));
  return [header, ...lines].join('\n');
}
```

In the handler, after building `rows` (the full mapped list, **before** the cursor slicing), branch on `format`:

```typescript
const format = typeof req.query.format === 'string' ? req.query.format : 'json';
if (format === 'csv') {
  const maxRows = Number(process.env.ITEMS_CSV_MAX_ROWS ?? '50000');
  // Re-query without the limit+1, capped at maxRows+1 to detect overflow.
  const allItems = await ExternalOrderItem.findAll({
    where: itemWhere,
    include: [
      { model: ExternalOrder, required: true, where: orderWhere,
        include: [{ model: Receipt, required: true,
          include: [{ model: Transaction, required: true, where: txnWhereWithDate, attributes: ['id', 'date'] }] }] },
    ],
    order: [['id', 'ASC']],
    limit: maxRows + 1,
  });
  if (allItems.length > maxRows) {
    res.status(413).json({ error: `Result set too large (>${maxRows} items). Narrow your filters.` });
    return;
  }
  const allRows = allItems.map(mapItemToRow);
  const csv = rowsToCsv(allRows);
  const filename = `items-${new Date().toISOString().slice(0, 10)}.csv`;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(csv);
  return;
}
```

Extract the row-mapping closure to a named function `mapItemToRow(item, includeOptions)` so the JSON branch and CSV branch share it. Adjust accordingly.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && yarn test:integration -- --test-name-pattern="format=csv"`

Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/routes/items.ts backend/test/integration/items.test.ts
git commit -m "feat(items): add CSV export branch with row-cap guard"
```

---

## Task 7: Backend — Bulk-patch endpoint

**Files:**
- Modify: `backend/src/routes/items.ts`
- Modify: `backend/test/integration/items.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `backend/test/integration/items.test.ts`:

```typescript
test('POST /api/external-order-items/bulk-patch updates many items', async () => {
  const householdAId = (await agentA.get('/api/auth/me')).body.user.householdId;
  const order = await ExternalOrder.create({
    householdId: householdAId, vendor: 'bulk', dedupeKey: 'bulk-1',
    total: '30', currency: 'USD', source: 'image',
  } as never);
  const txn = await Transaction.create({
    accountId: 1, householdId: householdAId, importBatch: 'b-bulk',
    date: '2026-05-10', merchantRaw: 'Z', merchantClean: 'Z', amount: '-30',
    currency: 'USD', sourceRowFingerprint: 'fp-bulk',
    visibility: 'shared', ownershipType: 'shared',
    finalCategory: null, finalBusiness: false, finalSplitType: 'none', businessAmount: '0',
  } as never);
  await Receipt.create({
    transactionId: txn.id, storedFilename: 'b.jpg', originalName: 'b.jpg',
    mimeType: 'image/jpeg', sizeBytes: 1, externalOrderId: order.id,
  } as never);
  const a = await ExternalOrderItem.create({ externalOrderId: order.id, title: 'a', quantity: 1, totalPrice: '10' } as never);
  const b = await ExternalOrderItem.create({ externalOrderId: order.id, title: 'b', quantity: 1, totalPrice: '10' } as never);
  const c = await ExternalOrderItem.create({ externalOrderId: order.id, title: 'c', quantity: 1, totalPrice: '10' } as never);

  const res = await agentA
    .post('/api/external-order-items/bulk-patch')
    .send({ itemIds: [a.id, b.id, c.id], categoryOverride: 'Office' });
  assert.equal(res.status, 200);
  assert.equal(res.body.updated, 3);

  for (const it of [a, b, c]) {
    await it.reload();
    assert.equal(it.categoryOverride, 'Office');
  }
});

test('POST /api/external-order-items/bulk-patch rejects empty itemIds', async () => {
  const res = await agentA.post('/api/external-order-items/bulk-patch').send({ itemIds: [], categoryOverride: 'X' });
  assert.equal(res.status, 400);
});

test('POST /api/external-order-items/bulk-patch rejects >200 itemIds', async () => {
  const ids = Array.from({ length: 201 }, (_, i) => i + 1);
  const res = await agentA.post('/api/external-order-items/bulk-patch').send({ itemIds: ids, categoryOverride: 'X' });
  assert.equal(res.status, 400);
});

test('POST /api/external-order-items/bulk-patch blocks cross-household', async () => {
  const householdAId = (await agentA.get('/api/auth/me')).body.user.householdId;
  const order = await ExternalOrder.create({
    householdId: householdAId, vendor: 'X', dedupeKey: 'x-1', total: '1', currency: 'USD', source: 'image',
  } as never);
  const txn = await Transaction.create({
    accountId: 1, householdId: householdAId, importBatch: 'b-x',
    date: '2026-05-01', merchantRaw: 'X', merchantClean: 'X', amount: '-1',
    currency: 'USD', sourceRowFingerprint: 'fp-x',
    visibility: 'shared', ownershipType: 'shared',
    finalCategory: null, finalBusiness: false, finalSplitType: 'none', businessAmount: '0',
  } as never);
  await Receipt.create({
    transactionId: txn.id, storedFilename: 'x.jpg', originalName: 'x.jpg',
    mimeType: 'image/jpeg', sizeBytes: 1, externalOrderId: order.id,
  } as never);
  const item = await ExternalOrderItem.create({ externalOrderId: order.id, title: 'priv', quantity: 1, totalPrice: '1' } as never);

  const res = await agentB.post('/api/external-order-items/bulk-patch').send({ itemIds: [item.id], categoryOverride: 'Z' });
  assert.equal(res.status, 403);

  await item.reload();
  assert.equal(item.categoryOverride, null);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && yarn test:integration -- --test-name-pattern="bulk-patch"`

Expected: FAIL — endpoint does not exist (404).

- [ ] **Step 3: Implement bulk-patch endpoint**

In `backend/src/routes/items.ts`, append:

```typescript
import { sequelize } from '../models/index.js';

router.post('/external-order-items/bulk-patch', async (req, res, next) => {
  try {
    const { household } = currentAuth(req);
    const body = req.body as {
      itemIds?: unknown;
      categoryOverride?: unknown;
      businessUseOverride?: unknown;
    };
    if (!Array.isArray(body.itemIds) || body.itemIds.length === 0) {
      res.status(400).json({ error: 'itemIds must be a non-empty array' });
      return;
    }
    if (body.itemIds.length > 200) {
      res.status(400).json({ error: 'cannot update more than 200 items at once' });
      return;
    }
    const ids = body.itemIds.map(Number).filter((n) => Number.isFinite(n));
    if (ids.length !== body.itemIds.length) {
      res.status(400).json({ error: 'itemIds must all be numbers' });
      return;
    }

    const patch: { categoryOverride?: string | null; businessUseOverride?: string | null } = {};
    if (Object.prototype.hasOwnProperty.call(body, 'categoryOverride')) {
      const v = body.categoryOverride;
      if (v !== null && typeof v !== 'string') {
        res.status(400).json({ error: 'categoryOverride must be string or null' });
        return;
      }
      patch.categoryOverride = v as string | null;
    }
    if (Object.prototype.hasOwnProperty.call(body, 'businessUseOverride')) {
      const v = body.businessUseOverride;
      if (v !== null && typeof v !== 'boolean') {
        res.status(400).json({ error: 'businessUseOverride must be boolean or null' });
        return;
      }
      patch.businessUseOverride = v === null ? null : v ? '100' : '0';
    }
    if (Object.keys(patch).length === 0) {
      res.status(400).json({ error: 'no fields to patch' });
      return;
    }

    const result = await sequelize.transaction(async (t) => {
      const items = await ExternalOrderItem.findAll({
        where: { id: ids },
        include: [{ model: ExternalOrder, required: true, where: { householdId: household.id } }],
        transaction: t,
      });
      if (items.length !== ids.length) {
        const err = new Error('one or more items not found or not in scope') as Error & { status?: number };
        err.status = 403;
        throw err;
      }
      let updated = 0;
      for (const it of items) {
        await it.update(patch, { transaction: t });
        updated += 1;
      }
      return updated;
    });

    res.json({ updated: result });
  } catch (e) {
    next(e);
  }
});
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && yarn test:integration -- --test-name-pattern="bulk-patch"`

Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/routes/items.ts backend/test/integration/items.test.ts
git commit -m "feat(items): add POST /api/external-order-items/bulk-patch"
```

---

## Task 8: Backend — Allocation endpoint

**Files:**
- Modify: `backend/src/routes/items.ts`
- Modify: `shared/api-types.ts`
- Modify: `backend/test/integration/items.test.ts`

- [ ] **Step 1: Add shared type**

Append to `shared/api-types.ts`:

```typescript
export type ItemAllocation = {
  itemId: number
  itemTotal: number
  allocatedTotal: number | null
  categoryBucket: string | null
  txnId: number | null
  txnAmount: number | null
  percentOfTxn: number | null
  linkedTxnIds: number[]
}
```

- [ ] **Step 2: Write the failing test**

Append to `backend/test/integration/items.test.ts`:

```typescript
test('GET /api/items/:id/allocation returns allocation for linked item', async () => {
  const householdAId = (await agentA.get('/api/auth/me')).body.user.householdId;
  const order = await ExternalOrder.create({
    householdId: householdAId, vendor: 'alloc', dedupeKey: 'alloc-1',
    subtotal: '40', tax: '2', shipping: '0', total: '42', currency: 'USD', source: 'image',
  } as never);
  const txn = await Transaction.create({
    accountId: 1, householdId: householdAId, importBatch: 'b-alloc',
    date: '2026-05-05', merchantRaw: 'Q', merchantClean: 'Q', amount: '-42',
    currency: 'USD', sourceRowFingerprint: 'fp-alloc',
    visibility: 'shared', ownershipType: 'shared',
    finalCategory: 'Office', finalBusiness: false, finalSplitType: 'none', businessAmount: '0',
  } as never);
  await Receipt.create({
    transactionId: txn.id, storedFilename: 'a.jpg', originalName: 'a.jpg',
    mimeType: 'image/jpeg', sizeBytes: 1, externalOrderId: order.id,
  } as never);
  const item = await ExternalOrderItem.create({
    externalOrderId: order.id, title: 'thing', quantity: 1, totalPrice: '40', inferredCategory: 'Office',
  } as never);

  const res = await agentA.get(`/api/items/${item.id}/allocation`);
  assert.equal(res.status, 200);
  assert.equal(res.body.itemId, item.id);
  assert.equal(res.body.txnId, txn.id);
  assert.equal(res.body.itemTotal, 40);
  // tax-prorated: 40 + 2 * (40/40) = 42
  assert.ok(Math.abs(res.body.allocatedTotal - 42) < 0.01);
  assert.equal(res.body.categoryBucket, 'Office');
});

test('GET /api/items/:id/allocation returns null txn for unlinked item', async () => {
  const householdAId = (await agentA.get('/api/auth/me')).body.user.householdId;
  const order = await ExternalOrder.create({
    householdId: householdAId, vendor: 'noLink', dedupeKey: 'nolink-1',
    total: '10', currency: 'USD', source: 'image',
  } as never);
  const item = await ExternalOrderItem.create({
    externalOrderId: order.id, title: 'orphan', quantity: 1, totalPrice: '10',
  } as never);
  // No Receipt → no Transaction link.

  const res = await agentA.get(`/api/items/${item.id}/allocation`);
  assert.equal(res.status, 200);
  assert.equal(res.body.txnId, null);
  assert.equal(res.body.allocatedTotal, null);
  assert.equal(res.body.itemTotal, 10);
});

test('GET /api/items/:id/allocation blocks cross-household', async () => {
  const householdAId = (await agentA.get('/api/auth/me')).body.user.householdId;
  const order = await ExternalOrder.create({
    householdId: householdAId, vendor: 'priv', dedupeKey: 'priv-alloc-1',
    total: '5', currency: 'USD', source: 'image',
  } as never);
  const item = await ExternalOrderItem.create({
    externalOrderId: order.id, title: 'secret', quantity: 1, totalPrice: '5',
  } as never);
  const res = await agentB.get(`/api/items/${item.id}/allocation`);
  assert.equal(res.status, 403);
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd backend && yarn test:integration -- --test-name-pattern="allocation"`

Expected: FAIL — endpoint missing.

- [ ] **Step 4: Implement allocation endpoint**

In `backend/src/routes/items.ts`, append:

```typescript
import { splitTxnByItems, type AllocatorItem, type AllocatorOrder } from '../import/splitTxnByItems.js';
import { TransactionOrderLink } from '../models/index.js';

router.get('/items/:id/allocation', async (req, res, next) => {
  try {
    const { household } = currentAuth(req);
    const itemId = Number(req.params.id);
    if (!Number.isFinite(itemId)) {
      res.status(400).json({ error: 'invalid item id' });
      return;
    }

    const item = await ExternalOrderItem.findOne({
      where: { id: itemId },
      include: [{ model: ExternalOrder, required: true, where: { householdId: household.id } }],
    });
    if (!item) {
      res.status(403).json({ error: 'not found or not in scope' });
      return;
    }
    const order = (item as ExternalOrderItem & { externalOrder?: ExternalOrder }).externalOrder!;

    const links = await TransactionOrderLink.findAll({
      where: { externalOrderId: order.id, status: { [Op.ne]: 'rejected' } },
    });
    const linkedTxnIds = links.map((l) => l.transactionId);

    if (linkedTxnIds.length === 0) {
      res.json({
        itemId: item.id,
        itemTotal: Number(item.totalPrice ?? '0'),
        allocatedTotal: null,
        categoryBucket: item.categoryOverride ?? item.inferredCategory ?? null,
        txnId: null,
        txnAmount: null,
        percentOfTxn: null,
        linkedTxnIds: [],
      });
      return;
    }

    // Pick the dominant link: highest linkedAmount, then most recent.
    const dominant = [...links].sort((a, b) => {
      const aAmt = Number(a.linkedAmount ?? 0);
      const bAmt = Number(b.linkedAmount ?? 0);
      if (aAmt !== bAmt) return bAmt - aAmt;
      return b.id - a.id;
    })[0];

    const txn = await Transaction.findByPk(dominant.transactionId);
    if (!txn) {
      res.json({
        itemId: item.id,
        itemTotal: Number(item.totalPrice ?? '0'),
        allocatedTotal: null,
        categoryBucket: item.categoryOverride ?? item.inferredCategory ?? null,
        txnId: null,
        txnAmount: null,
        percentOfTxn: null,
        linkedTxnIds,
      });
      return;
    }

    // Run the existing allocator over the entire (txn, order, items) tuple,
    // then find this item's contribution by mapping per-item math inline.
    const allItems = await ExternalOrderItem.findAll({ where: { externalOrderId: order.id } });
    const allocatorItems: AllocatorItem[] = allItems.map((it) => ({
      id: it.id,
      totalPrice: it.totalPrice,
      unitPrice: it.unitPrice,
      quantity: it.quantity,
      inferredCategory: it.inferredCategory,
      categoryOverride: it.categoryOverride,
      businessUsePercent: it.businessUsePercent,
      businessUseOverride: it.businessUseOverride,
    }));
    const allocatorOrder: AllocatorOrder = {
      id: order.id,
      subtotal: order.subtotal,
      tax: order.tax,
      shipping: order.shipping,
      total: order.total,
      currency: order.currency,
    };

    // Per-item allocated total = rawBase * share + extras * weight, mirroring splitTxnByItems.
    const orderTotal = Number(order.total ?? '0');
    const linkAmt = dominant.linkedAmount != null ? Number(dominant.linkedAmount) : orderTotal;
    const share = orderTotal > 0 ? linkAmt / orderTotal : 1;
    const itemBase = (it: AllocatorItem) =>
      it.totalPrice != null
        ? Number(it.totalPrice)
        : it.unitPrice != null
          ? Number(it.unitPrice) * (it.quantity || 1)
          : 0;
    const baseSum = allocatorItems.reduce((s, it) => s + itemBase(it), 0);
    const extras = (Number(allocatorOrder.tax ?? 0) + Number(allocatorOrder.shipping ?? 0)) * share;
    const rawBase = itemBase(allocatorItems.find((a) => a.id === item.id)!);
    const weight = baseSum > 0 ? rawBase / baseSum : 0;
    const allocated = baseSum > 0 ? rawBase * share + extras * weight : linkAmt / allocatorItems.length;

    const txnAmount = Math.abs(Number(txn.amount));
    res.json({
      itemId: item.id,
      itemTotal: Number(item.totalPrice ?? '0'),
      allocatedTotal: Math.round(allocated * 100) / 100,
      categoryBucket: item.categoryOverride ?? item.inferredCategory ?? txn.finalCategory ?? null,
      txnId: txn.id,
      txnAmount,
      percentOfTxn: txnAmount > 0 ? Math.round((allocated / txnAmount) * 1000) / 10 : null,
      linkedTxnIds,
    });
  } catch (e) {
    next(e);
  }
});
```

The unused import of `splitTxnByItems` is intentional — it documents that the per-item math here mirrors that function. If a future refactor extracts a `perItemAllocation()` helper from `splitTxnByItems`, this endpoint should call it instead of duplicating the math.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd backend && yarn test:integration -- --test-name-pattern="allocation"`

Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add backend/src/routes/items.ts backend/test/integration/items.test.ts shared/api-types.ts
git commit -m "feat(items): add GET /api/items/:id/allocation"
```

---

## Task 9: Frontend — `useItems` hook

**Files:**
- Create: `frontend/src/hooks/useItems.ts`
- Create: `frontend/src/hooks/useItems.test.ts`

- [ ] **Step 1: Write the failing test**

Create `frontend/src/hooks/useItems.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { useItemsQuery, type ItemsFilters } from './useItems'
import * as api from '@/lib/api'

vi.mock('@/lib/api')

const baseFilters: ItemsFilters = {}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('useItemsQuery', () => {
  it('returns loading then data on success', async () => {
    vi.mocked(api.getJson).mockResolvedValue({
      items: [{ id: 1, title: 'x', qty: 1, unitPrice: 1, totalPrice: 1, taxShare: 0,
        categoryEffective: null, categoryOverride: null, businessUseEffective: false, businessUseOverride: null,
        order: { id: 1, vendor: 'a' }, receipt: { id: 1, date: '2026-05-01', sourceTxnId: 1 } }],
      nextCursor: null,
    })
    const { result } = renderHook(() => useItemsQuery(baseFilters))
    expect(result.current.loading).toBe(true)
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.items).toHaveLength(1)
    expect(result.current.error).toBe(null)
  })

  it('sets error state on failure', async () => {
    vi.mocked(api.getJson).mockRejectedValue(new Error('boom'))
    const { result } = renderHook(() => useItemsQuery(baseFilters))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.error).toBeTruthy()
    expect(result.current.items).toEqual([])
  })

  it('discards stale response when filters change mid-flight', async () => {
    let resolveFirst: (v: unknown) => void = () => {}
    vi.mocked(api.getJson)
      .mockImplementationOnce(() => new Promise((r) => { resolveFirst = r }))
      .mockResolvedValueOnce({
        items: [{ id: 2, title: 'second', qty: 1, unitPrice: 1, totalPrice: 1, taxShare: 0,
          categoryEffective: null, categoryOverride: null, businessUseEffective: false, businessUseOverride: null,
          order: { id: 2, vendor: 'b' }, receipt: { id: 2, date: '2026-05-02', sourceTxnId: 2 } }],
        nextCursor: null,
      })

    const { result, rerender } = renderHook(({ f }) => useItemsQuery(f), {
      initialProps: { f: { category: 'X' } },
    })
    rerender({ f: { category: 'Y' } })
    resolveFirst({
      items: [{ id: 99, title: 'stale', qty: 1, unitPrice: 1, totalPrice: 1, taxShare: 0,
        categoryEffective: null, categoryOverride: null, businessUseEffective: false, businessUseOverride: null,
        order: { id: 99, vendor: 'old' }, receipt: { id: 99, date: '2020-01-01', sourceTxnId: 99 } }],
      nextCursor: null,
    })
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.items).toHaveLength(1)
    expect(result.current.items[0].id).toBe(2)
  })

  it('fetchMore appends rows and advances cursor', async () => {
    vi.mocked(api.getJson)
      .mockResolvedValueOnce({
        items: [{ id: 1, title: 'a', qty: 1, unitPrice: 1, totalPrice: 1, taxShare: 0,
          categoryEffective: null, categoryOverride: null, businessUseEffective: false, businessUseOverride: null,
          order: { id: 1, vendor: 'v' }, receipt: { id: 1, date: '2026-05-01', sourceTxnId: 1 } }],
        nextCursor: 'CURSOR1',
      })
      .mockResolvedValueOnce({
        items: [{ id: 2, title: 'b', qty: 1, unitPrice: 1, totalPrice: 1, taxShare: 0,
          categoryEffective: null, categoryOverride: null, businessUseEffective: false, businessUseOverride: null,
          order: { id: 1, vendor: 'v' }, receipt: { id: 1, date: '2026-05-01', sourceTxnId: 1 } }],
        nextCursor: null,
      })
    const { result } = renderHook(() => useItemsQuery(baseFilters))
    await waitFor(() => expect(result.current.loading).toBe(false))
    await result.current.fetchMore()
    await waitFor(() => expect(result.current.items).toHaveLength(2))
    expect(result.current.nextCursor).toBe(null)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && yarn test src/hooks/useItems.test.ts`

Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement the hook**

Create `frontend/src/hooks/useItems.ts`:

```typescript
import { useCallback, useEffect, useRef, useState } from 'react'
import { getJson } from '@/lib/api'
import type { ItemRow, ItemsListResponse, ItemAllocation } from '@cashflow/shared'

export type ItemsFilters = {
  category?: string
  businessUse?: 'true' | 'false'
  from?: string
  to?: string
  vendor?: string
  minPrice?: number
  maxPrice?: number
  q?: string
}

function buildQuery(filters: ItemsFilters, cursor: string | null): string {
  const p = new URLSearchParams()
  for (const [k, v] of Object.entries(filters)) {
    if (v == null || v === '') continue
    p.set(k, String(v))
  }
  if (cursor) p.set('cursor', cursor)
  const s = p.toString()
  return s ? `?${s}` : ''
}

export function useItemsQuery(filters: ItemsFilters) {
  const [items, setItems] = useState<ItemRow[]>([])
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<Error | null>(null)
  const filterKey = JSON.stringify(filters)
  const cursorRef = useRef<string | null>(null)
  cursorRef.current = nextCursor

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    void (async () => {
      try {
        const res = await getJson<ItemsListResponse>(`/api/items${buildQuery(filters, null)}`)
        if (cancelled) return
        setItems(res.items)
        setNextCursor(res.nextCursor)
      } catch (e) {
        if (cancelled) return
        setItems([])
        setError(e instanceof Error ? e : new Error(String(e)))
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterKey])

  const fetchMore = useCallback(async () => {
    const cursor = cursorRef.current
    if (!cursor) return
    try {
      const res = await getJson<ItemsListResponse>(`/api/items${buildQuery(filters, cursor)}`)
      setItems((prev) => [...prev, ...res.items])
      setNextCursor(res.nextCursor)
    } catch (e) {
      setError(e instanceof Error ? e : new Error(String(e)))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterKey])

  return { items, nextCursor, loading, error, fetchMore }
}

export function useItemAllocation(itemId: number | null) {
  const [data, setData] = useState<ItemAllocation | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<Error | null>(null)

  useEffect(() => {
    if (itemId == null) {
      setData(null)
      return
    }
    let cancelled = false
    setLoading(true)
    setError(null)
    void (async () => {
      try {
        const res = await getJson<ItemAllocation>(`/api/items/${itemId}/allocation`)
        if (!cancelled) setData(res)
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e : new Error(String(e)))
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [itemId])

  return { data, loading, error }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && yarn test src/hooks/useItems.test.ts`

Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/hooks/useItems.ts frontend/src/hooks/useItems.test.ts
git commit -m "feat(items): add useItemsQuery and useItemAllocation hooks"
```

---

## Task 10: Frontend — `ItemsFilterStrip` component

**Files:**
- Create: `frontend/src/components/items/ItemsFilterStrip.tsx`
- Create: `frontend/src/components/items/ItemsFilterStrip.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `frontend/src/components/items/ItemsFilterStrip.test.tsx`:

```typescript
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ItemsFilterStrip } from './ItemsFilterStrip'

describe('ItemsFilterStrip', () => {
  it('renders 5 chips', () => {
    render(<ItemsFilterStrip filters={{}} onChange={() => {}} />)
    expect(screen.getByRole('button', { name: /category/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /business use/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /date/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /vendor/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /price/i })).toBeInTheDocument()
  })

  it('opens a chip popover and applies value', () => {
    const onChange = vi.fn()
    render(<ItemsFilterStrip filters={{}} onChange={onChange} />)
    fireEvent.click(screen.getByRole('button', { name: /vendor/i }))
    const input = screen.getByPlaceholderText(/vendor name/i)
    fireEvent.change(input, { target: { value: 'amazon' } })
    fireEvent.click(screen.getByRole('button', { name: /apply/i }))
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ vendor: 'amazon' }))
  })

  it('shows active chip with value', () => {
    render(<ItemsFilterStrip filters={{ vendor: 'amazon' }} onChange={() => {}} />)
    expect(screen.getByRole('button', { name: /vendor: amazon/i })).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && yarn test src/components/items/ItemsFilterStrip.test.tsx`

Expected: FAIL — module missing.

- [ ] **Step 3: Implement the component**

Create `frontend/src/components/items/ItemsFilterStrip.tsx`:

```typescript
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import type { ItemsFilters } from '@/hooks/useItems'

type Props = {
  filters: ItemsFilters
  onChange: (next: ItemsFilters) => void
}

type ChipName = 'category' | 'businessUse' | 'date' | 'vendor' | 'price'

export function ItemsFilterStrip({ filters, onChange }: Props) {
  const [openChip, setOpenChip] = useState<ChipName | null>(null)

  const close = () => setOpenChip(null)
  const apply = (patch: Partial<ItemsFilters>) => {
    onChange({ ...filters, ...patch })
    close()
  }
  const clear = (k: keyof ItemsFilters) => {
    const next = { ...filters }
    delete next[k]
    onChange(next)
  }

  return (
    <div className="flex flex-wrap gap-2" role="toolbar" aria-label="Item filters">
      <Chip
        name="category"
        label={filters.category ? `Category: ${filters.category}` : 'Category'}
        active={!!filters.category}
        open={openChip === 'category'}
        onOpen={() => setOpenChip('category')}
        onClose={close}
        onClear={() => clear('category')}
      >
        <input
          autoFocus
          defaultValue={filters.category ?? ''}
          placeholder="Category name"
          className="rounded border px-2 py-1 text-sm"
          onKeyDown={(e) => {
            if (e.key === 'Enter') apply({ category: (e.target as HTMLInputElement).value })
            if (e.key === 'Escape') close()
          }}
        />
        <Button size="sm" onClick={(e) => apply({ category: ((e.currentTarget.previousSibling as HTMLInputElement)?.value) ?? undefined })}>
          Apply
        </Button>
      </Chip>

      <Chip
        name="businessUse"
        label={filters.businessUse ? `Business: ${filters.businessUse}` : 'Business use'}
        active={!!filters.businessUse}
        open={openChip === 'businessUse'}
        onOpen={() => setOpenChip('businessUse')}
        onClose={close}
        onClear={() => clear('businessUse')}
      >
        <Button size="sm" variant="outline" onClick={() => apply({ businessUse: 'true' })}>Yes</Button>
        <Button size="sm" variant="outline" onClick={() => apply({ businessUse: 'false' })}>No</Button>
      </Chip>

      <Chip
        name="date"
        label={filters.from || filters.to ? `Date: ${filters.from ?? '…'} → ${filters.to ?? '…'}` : 'Date'}
        active={!!(filters.from || filters.to)}
        open={openChip === 'date'}
        onOpen={() => setOpenChip('date')}
        onClose={close}
        onClear={() => onChange({ ...filters, from: undefined, to: undefined })}
      >
        <input type="date" defaultValue={filters.from ?? ''} placeholder="From" className="rounded border px-2 py-1 text-sm" id="filter-date-from" />
        <input type="date" defaultValue={filters.to ?? ''} placeholder="To" className="rounded border px-2 py-1 text-sm" id="filter-date-to" />
        <Button size="sm" onClick={() => {
          const from = (document.getElementById('filter-date-from') as HTMLInputElement).value || undefined
          const to = (document.getElementById('filter-date-to') as HTMLInputElement).value || undefined
          apply({ from, to })
        }}>Apply</Button>
      </Chip>

      <Chip
        name="vendor"
        label={filters.vendor ? `Vendor: ${filters.vendor}` : 'Vendor'}
        active={!!filters.vendor}
        open={openChip === 'vendor'}
        onOpen={() => setOpenChip('vendor')}
        onClose={close}
        onClear={() => clear('vendor')}
      >
        <input
          autoFocus
          defaultValue={filters.vendor ?? ''}
          placeholder="Vendor name"
          className="rounded border px-2 py-1 text-sm"
          id="filter-vendor"
          onKeyDown={(e) => { if (e.key === 'Enter') apply({ vendor: (e.target as HTMLInputElement).value }) }}
        />
        <Button size="sm" onClick={() => apply({ vendor: (document.getElementById('filter-vendor') as HTMLInputElement).value || undefined })}>
          Apply
        </Button>
      </Chip>

      <Chip
        name="price"
        label={filters.minPrice != null || filters.maxPrice != null ? `Price: $${filters.minPrice ?? 0}–$${filters.maxPrice ?? '∞'}` : 'Price'}
        active={!!(filters.minPrice != null || filters.maxPrice != null)}
        open={openChip === 'price'}
        onOpen={() => setOpenChip('price')}
        onClose={close}
        onClear={() => onChange({ ...filters, minPrice: undefined, maxPrice: undefined })}
      >
        <input type="number" defaultValue={filters.minPrice ?? ''} placeholder="min" className="rounded border px-2 py-1 text-sm w-20" id="filter-price-min" />
        <input type="number" defaultValue={filters.maxPrice ?? ''} placeholder="max" className="rounded border px-2 py-1 text-sm w-20" id="filter-price-max" />
        <Button size="sm" onClick={() => {
          const minRaw = (document.getElementById('filter-price-min') as HTMLInputElement).value
          const maxRaw = (document.getElementById('filter-price-max') as HTMLInputElement).value
          apply({
            minPrice: minRaw ? Number(minRaw) : undefined,
            maxPrice: maxRaw ? Number(maxRaw) : undefined,
          })
        }}>Apply</Button>
      </Chip>
    </div>
  )
}

function Chip({
  name, label, active, open, onOpen, onClose, onClear, children,
}: {
  name: ChipName
  label: string
  active: boolean
  open: boolean
  onOpen: () => void
  onClose: () => void
  onClear: () => void
  children: React.ReactNode
}) {
  return (
    <div className="relative">
      <button
        type="button"
        role="button"
        aria-expanded={open}
        aria-label={label}
        onClick={(e) => {
          if (e.metaKey && active) {
            onClear()
            return
          }
          open ? onClose() : onOpen()
        }}
        className={`rounded-full px-3 py-1 text-sm border ${active ? 'bg-card text-foreground border-foreground' : 'bg-muted/30 text-muted-foreground'}`}
      >
        {label}
      </button>
      {open && (
        <div className="absolute z-10 mt-1 flex gap-2 bg-card border border-border rounded p-2 shadow">
          {children}
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && yarn test src/components/items/ItemsFilterStrip.test.tsx`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/items/ItemsFilterStrip.tsx frontend/src/components/items/ItemsFilterStrip.test.tsx
git commit -m "feat(items): add ItemsFilterStrip with five filter chips"
```

---

## Task 11: Frontend — `ItemDetailDrawer` component

**Files:**
- Create: `frontend/src/components/items/ItemDetailDrawer.tsx`
- Create: `frontend/src/components/items/ItemDetailDrawer.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `frontend/src/components/items/ItemDetailDrawer.test.tsx`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { ItemDetailDrawer } from './ItemDetailDrawer'
import * as api from '@/lib/api'

vi.mock('@/lib/api')

const sampleAlloc = {
  itemId: 1, itemTotal: 19, allocatedTotal: 19.99, categoryBucket: 'Office',
  txnId: 100, txnAmount: 42.18, percentOfTxn: 47.4, linkedTxnIds: [100],
}

describe('ItemDetailDrawer', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders nothing when itemId is null', () => {
    const { container } = render(<ItemDetailDrawer itemId={null} item={null} onClose={() => {}} onPatched={() => {}} />)
    expect(container.firstChild).toBe(null)
  })

  it('fetches and renders allocation when itemId is set', async () => {
    vi.mocked(api.getJson).mockResolvedValue(sampleAlloc)
    const item = { id: 1, title: 'USB-C', qty: 2, unitPrice: 9.5, totalPrice: 19, taxShare: 0,
      categoryEffective: 'Office', categoryOverride: null, businessUseEffective: true, businessUseOverride: null,
      order: { id: 1, vendor: 'amazon' }, receipt: { id: 1, date: '2026-05-20', sourceTxnId: 100 } }
    render(<ItemDetailDrawer itemId={1} item={item} onClose={() => {}} onPatched={() => {}} />)
    await waitFor(() => expect(screen.getByText(/USB-C/)).toBeInTheDocument())
    await waitFor(() => expect(screen.getByText(/19\.99/)).toBeInTheDocument())
    expect(screen.getByText(/47\.4%/)).toBeInTheDocument()
  })

  it('closes on Esc', () => {
    const onClose = vi.fn()
    vi.mocked(api.getJson).mockResolvedValue(sampleAlloc)
    const item = { id: 1, title: 'x', qty: 1, unitPrice: 1, totalPrice: 1, taxShare: 0,
      categoryEffective: null, categoryOverride: null, businessUseEffective: false, businessUseOverride: null,
      order: { id: 1, vendor: 'v' }, receipt: { id: 1, date: '2026-05-01', sourceTxnId: 1 } }
    render(<ItemDetailDrawer itemId={1} item={item} onClose={onClose} onPatched={() => {}} />)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
  })

  it('PATCH on save', async () => {
    vi.mocked(api.getJson).mockResolvedValue(sampleAlloc)
    const patchSpy = vi.spyOn(api, 'patchJson' as never).mockResolvedValue({})
    const onPatched = vi.fn()
    const item = { id: 1, title: 'x', qty: 1, unitPrice: 1, totalPrice: 1, taxShare: 0,
      categoryEffective: 'Old', categoryOverride: 'Old', businessUseEffective: false, businessUseOverride: null,
      order: { id: 1, vendor: 'v' }, receipt: { id: 1, date: '2026-05-01', sourceTxnId: 1 } }
    render(<ItemDetailDrawer itemId={1} item={item} onClose={() => {}} onPatched={onPatched} />)
    const input = await screen.findByLabelText(/category override/i)
    fireEvent.change(input, { target: { value: 'New' } })
    fireEvent.click(screen.getByRole('button', { name: /save/i }))
    await waitFor(() => expect(patchSpy).toHaveBeenCalled())
    expect(onPatched).toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Verify `patchJson` exists in `@/lib/api`**

Run: `grep -n "patchJson\|export async function patch" frontend/src/lib/api.ts`

If `patchJson` is not defined, add it to `frontend/src/lib/api.ts` alongside `getJson`:

```typescript
export async function patchJson<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch(`${base}${path}`, {
    method: 'PATCH',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!r.ok) throw await apiError(r, path)
  return parseJson<T>(r)
}
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd frontend && yarn test src/components/items/ItemDetailDrawer.test.tsx`

Expected: FAIL — module missing.

- [ ] **Step 4: Implement the drawer**

Create `frontend/src/components/items/ItemDetailDrawer.tsx`:

```typescript
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { patchJson } from '@/lib/api'
import { useItemAllocation } from '@/hooks/useItems'
import type { ItemRow } from '@cashflow/shared'

type Props = {
  itemId: number | null
  item: ItemRow | null
  onClose: () => void
  onPatched: (next: Partial<ItemRow>) => void
}

export function ItemDetailDrawer({ itemId, item, onClose, onPatched }: Props) {
  const { data: alloc, loading } = useItemAllocation(itemId)
  const [categoryOverride, setCategoryOverride] = useState<string>('')
  const [businessOverride, setBusinessOverride] = useState<'unset' | 'true' | 'false'>('unset')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (item) {
      setCategoryOverride(item.categoryOverride ?? '')
      setBusinessOverride(
        item.businessUseOverride == null ? 'unset' : item.businessUseOverride ? 'true' : 'false',
      )
    }
  }, [item])

  useEffect(() => {
    if (itemId == null) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [itemId, onClose])

  if (itemId == null || !item) return null

  const save = async () => {
    setSaving(true)
    try {
      const patch: { categoryOverride?: string | null; businessUseOverride?: boolean | null } = {}
      if (categoryOverride !== (item.categoryOverride ?? '')) {
        patch.categoryOverride = categoryOverride === '' ? null : categoryOverride
      }
      if (businessOverride !== (item.businessUseOverride == null ? 'unset' : item.businessUseOverride ? 'true' : 'false')) {
        patch.businessUseOverride = businessOverride === 'unset' ? null : businessOverride === 'true'
      }
      if (Object.keys(patch).length > 0) {
        await patchJson(`/api/external-order-items/${item.id}`, patch)
        onPatched({
          categoryOverride: patch.categoryOverride ?? null,
          categoryEffective: patch.categoryOverride ?? item.categoryEffective,
          businessUseOverride: patch.businessUseOverride == null ? null : !!patch.businessUseOverride,
          businessUseEffective:
            patch.businessUseOverride == null ? item.businessUseEffective : !!patch.businessUseOverride,
        })
      }
      onClose()
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/40" onClick={onClose} aria-hidden="true" />
      <aside
        role="dialog"
        aria-label={`Item details: ${item.title}`}
        className="fixed inset-y-0 right-0 z-50 w-[480px] max-w-full bg-card border-l border-border p-4 overflow-y-auto"
      >
        <header className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold">{item.title}</h2>
          <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close drawer">×</Button>
        </header>

        <dl className="grid grid-cols-2 gap-2 text-sm">
          <dt>Vendor</dt><dd>{item.order.vendor}</dd>
          <dt>Date</dt><dd>{item.receipt.date ?? '—'}</dd>
          <dt>Quantity</dt><dd>{item.qty}</dd>
          <dt>Unit price</dt><dd>{item.unitPrice != null ? `$${item.unitPrice.toFixed(2)}` : '—'}</dd>
          <dt>Total price</dt><dd>{item.totalPrice != null ? `$${item.totalPrice.toFixed(2)}` : '—'}</dd>
        </dl>

        <section className="mt-6">
          <h3 className="text-sm font-medium mb-2">Category override</h3>
          <input
            aria-label="Category override"
            value={categoryOverride}
            onChange={(e) => setCategoryOverride(e.target.value)}
            placeholder={item.categoryEffective ?? 'No category'}
            className="w-full rounded border px-2 py-1 text-sm"
          />
        </section>

        <section className="mt-4">
          <h3 className="text-sm font-medium mb-2">Business use</h3>
          <select
            aria-label="Business use override"
            value={businessOverride}
            onChange={(e) => setBusinessOverride(e.target.value as 'unset' | 'true' | 'false')}
            className="rounded border px-2 py-1 text-sm"
          >
            <option value="unset">Use inferred</option>
            <option value="true">Business</option>
            <option value="false">Personal</option>
          </select>
        </section>

        <section className="mt-6 border-t pt-4">
          <h3 className="text-sm font-medium mb-2">Allocation</h3>
          {loading && <p className="text-sm text-muted-foreground">Loading…</p>}
          {!loading && alloc && alloc.txnId == null && (
            <p className="text-sm text-muted-foreground">Not linked to a transaction yet.</p>
          )}
          {!loading && alloc && alloc.txnId != null && (
            <dl className="grid grid-cols-2 gap-2 text-sm">
              <dt>Allocated total</dt><dd>${alloc.allocatedTotal?.toFixed(2)}</dd>
              <dt>Category bucket</dt><dd>{alloc.categoryBucket ?? '—'}</dd>
              <dt>Linked txn</dt><dd>#{alloc.txnId}</dd>
              <dt>Txn amount</dt><dd>${alloc.txnAmount?.toFixed(2)}</dd>
              <dt>% of txn</dt><dd>{alloc.percentOfTxn?.toFixed(1)}%</dd>
              {alloc.linkedTxnIds.length > 1 && (
                <>
                  <dt>Also linked to</dt>
                  <dd>{alloc.linkedTxnIds.slice(1).map((id) => `#${id}`).join(', ')}</dd>
                </>
              )}
            </dl>
          )}
        </section>

        <footer className="mt-6 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={() => void save()} disabled={saving}>Save</Button>
        </footer>
      </aside>
    </>
  )
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd frontend && yarn test src/components/items/ItemDetailDrawer.test.tsx`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/items/ItemDetailDrawer.tsx frontend/src/components/items/ItemDetailDrawer.test.tsx frontend/src/lib/api.ts
git commit -m "feat(items): add ItemDetailDrawer with allocation panel"
```

---

## Task 12: Frontend — `ItemsBrowse` component

**Files:**
- Create: `frontend/src/components/items/ItemsBrowse.tsx`
- Create: `frontend/src/components/items/ItemsBrowse.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `frontend/src/components/items/ItemsBrowse.test.tsx`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { ItemsBrowse } from './ItemsBrowse'
import * as api from '@/lib/api'
import type { ItemRow } from '@cashflow/shared'

vi.mock('@/lib/api')

const sample: ItemRow[] = [
  { id: 1, title: 'A', qty: 1, unitPrice: 5, totalPrice: 5, taxShare: 0,
    categoryEffective: 'Office', categoryOverride: null, businessUseEffective: true, businessUseOverride: null,
    order: { id: 10, vendor: 'amazon' }, receipt: { id: 100, date: '2026-05-20', sourceTxnId: 1000 } },
  { id: 2, title: 'B', qty: 1, unitPrice: 5, totalPrice: 5, taxShare: 0,
    categoryEffective: 'Office', categoryOverride: null, businessUseEffective: true, businessUseOverride: null,
    order: { id: 10, vendor: 'amazon' }, receipt: { id: 100, date: '2026-05-20', sourceTxnId: 1000 } },
  { id: 3, title: 'C', qty: 1, unitPrice: 5, totalPrice: 5, taxShare: 0,
    categoryEffective: 'Grocery', categoryOverride: null, businessUseEffective: false, businessUseOverride: null,
    order: { id: 11, vendor: 'costco' }, receipt: { id: 101, date: '2026-05-19', sourceTxnId: 1001 } },
]

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(api.getJson).mockResolvedValue({ items: sample, nextCursor: null })
})

describe('ItemsBrowse', () => {
  it('renders grouped by receipt with collapsible group headers', async () => {
    render(<ItemsBrowse filters={{}} onOpenItem={() => {}} />)
    await waitFor(() => expect(screen.getByText(/amazon/i)).toBeInTheDocument())
    expect(screen.getByText(/3 items/)).toBeInTheDocument() // total count
    expect(screen.getByText(/2 items/)).toBeInTheDocument() // amazon group
    expect(screen.getByText(/1 items/)).toBeInTheDocument() // costco group
  })

  it('toggles group-by mode', async () => {
    render(<ItemsBrowse filters={{}} onOpenItem={() => {}} />)
    await waitFor(() => expect(screen.getByText(/amazon/i)).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: /group by/i }))
    fireEvent.click(screen.getByRole('menuitem', { name: /category/i }))
    expect(screen.getByText(/^Office$/)).toBeInTheDocument()
    expect(screen.getByText(/^Grocery$/)).toBeInTheDocument()
  })

  it('multi-select shows toolbar with count', async () => {
    render(<ItemsBrowse filters={{}} onOpenItem={() => {}} />)
    await waitFor(() => expect(screen.getByText(/^A$/)).toBeInTheDocument())
    const checkboxes = screen.getAllByRole('checkbox', { name: /select item/i })
    fireEvent.click(checkboxes[0])
    fireEvent.click(checkboxes[1])
    expect(screen.getByText(/2 selected/i)).toBeInTheDocument()
  })

  it('row click invokes onOpenItem', async () => {
    const onOpen = vi.fn()
    render(<ItemsBrowse filters={{}} onOpenItem={onOpen} />)
    await waitFor(() => expect(screen.getByText(/^A$/)).toBeInTheDocument())
    fireEvent.click(screen.getByText(/^A$/))
    expect(onOpen).toHaveBeenCalledWith(1)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && yarn test src/components/items/ItemsBrowse.test.tsx`

Expected: FAIL — module missing.

- [ ] **Step 3: Implement the component**

Create `frontend/src/components/items/ItemsBrowse.tsx`:

```typescript
import { useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { useItemsQuery, type ItemsFilters } from '@/hooks/useItems'
import { patchJson } from '@/lib/api'
import type { ItemRow } from '@cashflow/shared'

type GroupBy = 'receipt' | 'category' | 'none'

type Props = {
  filters: ItemsFilters
  onOpenItem: (id: number) => void
  onItemsPatched?: () => void
}

export function ItemsBrowse({ filters, onOpenItem, onItemsPatched }: Props) {
  const { items, nextCursor, loading, error, fetchMore } = useItemsQuery(filters)
  const [groupBy, setGroupBy] = useState<GroupBy>('receipt')
  const [groupMenuOpen, setGroupMenuOpen] = useState(false)
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const sentinelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = sentinelRef.current
    if (!el || !nextCursor) return
    const io = new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting) void fetchMore()
    }, { rootMargin: '300px' })
    io.observe(el)
    return () => io.disconnect()
  }, [nextCursor, fetchMore])

  const groups = useMemo(() => groupItems(items, groupBy), [items, groupBy])

  const toggleSelect = (id: number) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const clearSelection = () => setSelected(new Set())

  const bulkSetCategory = async () => {
    const cat = window.prompt('Category for selected items (blank to clear):') ?? ''
    if (cat === null) return
    await patchJson('/api/external-order-items/bulk-patch', {
      itemIds: [...selected],
      categoryOverride: cat === '' ? null : cat,
    })
    clearSelection()
    onItemsPatched?.()
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <p className="text-sm text-muted-foreground">{items.length} items{nextCursor ? '+' : ''}</p>
        <div className="relative">
          <Button size="sm" variant="outline" onClick={() => setGroupMenuOpen((o) => !o)}>
            Group by: {groupBy}
          </Button>
          {groupMenuOpen && (
            <div role="menu" className="absolute z-10 mt-1 bg-card border border-border rounded shadow text-sm">
              {(['receipt', 'category', 'none'] as GroupBy[]).map((g) => (
                <button
                  key={g}
                  role="menuitem"
                  className="block w-full text-left px-3 py-1 hover:bg-muted"
                  onClick={() => { setGroupBy(g); setGroupMenuOpen(false) }}
                >
                  {g}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {selected.size > 0 && (
        <div role="toolbar" aria-label="Bulk actions" className="sticky top-0 z-10 flex items-center gap-2 bg-card border border-border rounded p-2">
          <span className="text-sm">{selected.size} selected</span>
          <Button size="sm" onClick={() => void bulkSetCategory()}>Set category</Button>
          <Button size="sm" variant="ghost" onClick={clearSelection}>Clear</Button>
        </div>
      )}

      {loading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {error && <p className="text-sm text-destructive">Failed to load items. {error.message}</p>}
      {!loading && !error && items.length === 0 && (
        <p className="text-sm text-muted-foreground">No items match these filters.</p>
      )}

      {groups.map((g) => (
        <section key={g.key}>
          {groupBy !== 'none' && (
            <h3 className="text-sm font-semibold mt-3 mb-1">{g.label} <span className="text-muted-foreground font-normal">· {g.rows.length} items</span></h3>
          )}
          <ul className="divide-y divide-border">
            {g.rows.map((r) => (
              <li key={r.id} className="flex items-center gap-2 py-1 text-sm">
                <input
                  type="checkbox"
                  aria-label={`Select item ${r.title}`}
                  checked={selected.has(r.id)}
                  onChange={() => toggleSelect(r.id)}
                />
                <button className="flex-1 text-left" onClick={() => onOpenItem(r.id)}>{r.title}</button>
                <span className="text-muted-foreground">{r.categoryEffective ?? '—'}</span>
                <span className="w-16 text-right">{r.totalPrice != null ? `$${r.totalPrice.toFixed(2)}` : '—'}</span>
              </li>
            ))}
          </ul>
        </section>
      ))}

      <div ref={sentinelRef} aria-hidden="true" />
    </div>
  )
}

function groupItems(rows: ItemRow[], by: GroupBy): { key: string; label: string; rows: ItemRow[] }[] {
  if (by === 'none') return [{ key: 'all', label: 'All', rows }]
  const buckets = new Map<string, { key: string; label: string; rows: ItemRow[] }>()
  for (const r of rows) {
    const key = by === 'receipt' ? `${r.receipt.id}` : (r.categoryEffective ?? '__none__')
    const label = by === 'receipt'
      ? `${r.order.vendor} · ${r.receipt.date ?? '—'}`
      : (r.categoryEffective ?? 'Uncategorized')
    if (!buckets.has(key)) buckets.set(key, { key, label, rows: [] })
    buckets.get(key)!.rows.push(r)
  }
  return [...buckets.values()]
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && yarn test src/components/items/ItemsBrowse.test.tsx`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/items/ItemsBrowse.tsx frontend/src/components/items/ItemsBrowse.test.tsx
git commit -m "feat(items): add ItemsBrowse with grouped table, multi-select, infinite scroll"
```

---

## Task 13: Frontend — `ItemsSearch` component

**Files:**
- Create: `frontend/src/components/items/ItemsSearch.tsx`
- Create: `frontend/src/components/items/ItemsSearch.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `frontend/src/components/items/ItemsSearch.test.tsx`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { ItemsSearch } from './ItemsSearch'
import * as api from '@/lib/api'

vi.mock('@/lib/api')

beforeEach(() => {
  vi.useFakeTimers()
  vi.mocked(api.getJson).mockResolvedValue({ items: [], nextCursor: null })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('ItemsSearch', () => {
  it('debounces input by 300ms', async () => {
    render(<ItemsSearch filters={{}} onChangeFilters={() => {}} onOpenItem={() => {}} />)
    const input = screen.getByPlaceholderText(/search items/i)
    fireEvent.change(input, { target: { value: 'usb' } })
    expect(api.getJson).toHaveBeenCalledTimes(1) // initial mount call with no q
    vi.advanceTimersByTime(299)
    expect(api.getJson).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(2)
    await waitFor(() => expect(api.getJson).toHaveBeenCalledWith(expect.stringContaining('q=usb')))
  })

  it('export opens CSV URL', () => {
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null)
    render(<ItemsSearch filters={{ vendor: 'amazon' }} onChangeFilters={() => {}} onOpenItem={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: /export csv/i }))
    expect(openSpy).toHaveBeenCalledWith(expect.stringContaining('format=csv'), '_blank')
    expect(openSpy).toHaveBeenCalledWith(expect.stringContaining('vendor=amazon'), '_blank')
  })
})
```

(Note: `afterEach` is from `vitest` — add the import.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && yarn test src/components/items/ItemsSearch.test.tsx`

Expected: FAIL — module missing.

- [ ] **Step 3: Implement the component**

Create `frontend/src/components/items/ItemsSearch.tsx`:

```typescript
import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { ItemsBrowse } from './ItemsBrowse'
import type { ItemsFilters } from '@/hooks/useItems'

type Props = {
  filters: ItemsFilters
  onChangeFilters: (next: ItemsFilters) => void
  onOpenItem: (id: number) => void
}

export function ItemsSearch({ filters, onChangeFilters, onOpenItem }: Props) {
  const [q, setQ] = useState(filters.q ?? '')
  const debounceRef = useRef<number | null>(null)

  useEffect(() => {
    if (debounceRef.current) window.clearTimeout(debounceRef.current)
    debounceRef.current = window.setTimeout(() => {
      onChangeFilters({ ...filters, q: q || undefined })
    }, 300)
    return () => {
      if (debounceRef.current) window.clearTimeout(debounceRef.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q])

  const exportUrl = () => {
    const p = new URLSearchParams()
    for (const [k, v] of Object.entries(filters)) {
      if (v == null || v === '') continue
      p.set(k, String(v))
    }
    if (q) p.set('q', q)
    p.set('format', 'csv')
    return `/api/items?${p.toString()}`
  }

  return (
    <div className="space-y-3">
      <div className="flex gap-2 items-center">
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search items"
          className="flex-1 rounded border px-2 py-1 text-sm"
          aria-label="Search items"
        />
        <Button size="sm" onClick={() => window.open(exportUrl(), '_blank')}>
          Export CSV
        </Button>
      </div>
      <ItemsBrowse
        filters={{ ...filters, q: q || undefined }}
        onOpenItem={onOpenItem}
      />
    </div>
  )
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && yarn test src/components/items/ItemsSearch.test.tsx`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/items/ItemsSearch.tsx frontend/src/components/items/ItemsSearch.test.tsx
git commit -m "feat(items): add ItemsSearch with debounced query and CSV export"
```

---

## Task 14: Frontend — `ItemsPage` shell with tabs + URL sync

**Files:**
- Create: `frontend/src/pages/ItemsPage.tsx`
- Create: `frontend/src/pages/ItemsPage.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `frontend/src/pages/ItemsPage.test.tsx`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { ItemsPage } from './ItemsPage'
import * as api from '@/lib/api'

vi.mock('@/lib/api')

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(api.getJson).mockResolvedValue({ items: [], nextCursor: null })
})

function renderAt(url: string) {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <Routes>
        <Route path="/items" element={<ItemsPage />} />
      </Routes>
    </MemoryRouter>,
  )
}

describe('ItemsPage', () => {
  it('renders three tabs with Browse default', async () => {
    renderAt('/items')
    expect(screen.getByRole('tab', { name: /browse/i })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tab', { name: /analyze/i })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: /search/i })).toBeInTheDocument()
  })

  it('honors ?tab=search', () => {
    renderAt('/items?tab=search')
    expect(screen.getByRole('tab', { name: /search/i })).toHaveAttribute('aria-selected', 'true')
  })

  it('analyze tab renders coming-soon placeholder', () => {
    renderAt('/items?tab=analyze')
    expect(screen.getByText(/coming soon/i)).toBeInTheDocument()
  })

  it('filter chip change refetches', async () => {
    renderAt('/items')
    await waitFor(() => expect(api.getJson).toHaveBeenCalledTimes(1))
    fireEvent.click(screen.getByRole('button', { name: /vendor/i }))
    fireEvent.change(screen.getByPlaceholderText(/vendor name/i), { target: { value: 'amazon' } })
    fireEvent.click(screen.getByRole('button', { name: /apply/i }))
    await waitFor(() => expect(api.getJson).toHaveBeenLastCalledWith(expect.stringContaining('vendor=amazon')))
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && yarn test src/pages/ItemsPage.test.tsx`

Expected: FAIL — module missing.

- [ ] **Step 3: Implement the page**

Create `frontend/src/pages/ItemsPage.tsx`:

```typescript
import { useCallback, useMemo } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Tabs, TabPanel } from '@/components/ui/tabs'
import { ItemsBrowse } from '@/components/items/ItemsBrowse'
import { ItemsSearch } from '@/components/items/ItemsSearch'
import { ItemsFilterStrip } from '@/components/items/ItemsFilterStrip'
import { ItemDetailDrawer } from '@/components/items/ItemDetailDrawer'
import type { ItemsFilters } from '@/hooks/useItems'
import type { ItemRow } from '@cashflow/shared'

type TabKey = 'browse' | 'analyze' | 'search'

const TAB_ITEMS = [
  { value: 'browse', label: 'Browse' },
  { value: 'analyze', label: 'Analyze' },
  { value: 'search', label: 'Search' },
]

function parseFilters(params: URLSearchParams): ItemsFilters {
  const get = (k: string) => {
    const v = params.get(k)
    return v && v.length > 0 ? v : undefined
  }
  const num = (k: string) => {
    const v = get(k)
    if (v == null) return undefined
    const n = Number(v)
    return Number.isFinite(n) ? n : undefined
  }
  const bu = get('businessUse')
  return {
    category: get('category'),
    businessUse: bu === 'true' || bu === 'false' ? bu : undefined,
    from: get('from'),
    to: get('to'),
    vendor: get('vendor'),
    minPrice: num('minPrice'),
    maxPrice: num('maxPrice'),
    q: get('q'),
  }
}

function writeFilters(params: URLSearchParams, next: ItemsFilters): URLSearchParams {
  const p = new URLSearchParams(params)
  const keys: (keyof ItemsFilters)[] = ['category', 'businessUse', 'from', 'to', 'vendor', 'minPrice', 'maxPrice', 'q']
  for (const k of keys) {
    const v = next[k]
    if (v == null || v === '') p.delete(k)
    else p.set(k, String(v))
  }
  return p
}

export function ItemsPage() {
  const [params, setParams] = useSearchParams()
  const tab = (params.get('tab') as TabKey | null) ?? 'browse'
  const itemIdRaw = params.get('item')
  const itemId = itemIdRaw && /^\d+$/.test(itemIdRaw) ? Number(itemIdRaw) : null
  const filters = useMemo(() => parseFilters(params), [params])

  const setTab = (v: string) => {
    const p = new URLSearchParams(params)
    p.set('tab', v)
    setParams(p, { replace: true })
  }

  const setFilters = useCallback((next: ItemsFilters) => {
    setParams(writeFilters(params, next), { replace: true })
  }, [params, setParams])

  const openItem = (id: number) => {
    const p = new URLSearchParams(params)
    p.set('item', String(id))
    setParams(p, { replace: true })
  }

  const closeItem = () => {
    const p = new URLSearchParams(params)
    p.delete('item')
    setParams(p, { replace: true })
  }

  // Held openItem row (for drawer prefill). Looked up via a tiny in-page cache.
  // For PR-A simplicity, we re-fetch only the allocation; the row data shown in
  // the drawer header comes from props provided by Browse/Search components in a
  // future revision. For now, pass a stub row to keep the drawer rendering.
  const openItemRow: ItemRow | null = null

  return (
    <div className="space-y-4">
      <header className="space-y-3">
        <h1 className="text-xl font-semibold">Items</h1>
        <Tabs items={TAB_ITEMS} value={tab} onValueChange={setTab} />
        {(tab === 'browse' || tab === 'search') && (
          <ItemsFilterStrip filters={filters} onChange={setFilters} />
        )}
      </header>

      <TabPanel value="browse" active={tab}>
        <ItemsBrowse filters={filters} onOpenItem={openItem} />
      </TabPanel>
      <TabPanel value="analyze" active={tab}>
        <p className="text-sm text-muted-foreground">Analyze tab — coming soon.</p>
      </TabPanel>
      <TabPanel value="search" active={tab}>
        <ItemsSearch filters={filters} onChangeFilters={setFilters} onOpenItem={openItem} />
      </TabPanel>

      <ItemDetailDrawer itemId={itemId} item={openItemRow} onClose={closeItem} onPatched={() => { /* PR-A: page-level cache refresh punted to next iteration */ }} />
    </div>
  )
}
```

**Note on drawer row prefill:** `ItemsBrowse` and `ItemsSearch` currently know the item row but the page does not. For PR-A the drawer header reads `item.title` etc. from a prop — pass it through. To keep this task self-contained, wire the row by lifting a "last opened item row" state in `ItemsPage` and passing a setter into both subtab components. Update step 4 below.

- [ ] **Step 4: Lift opened-item-row state**

Replace the `openItem` callback in `ItemsPage.tsx` and pass row data through. Add at the top of `ItemsPage`:

```typescript
const [openItemRow, setOpenItemRow] = useState<ItemRow | null>(null)

const openItem = (id: number, row: ItemRow) => {
  setOpenItemRow(row)
  const p = new URLSearchParams(params)
  p.set('item', String(id))
  setParams(p, { replace: true })
}
```

Update `ItemsBrowse` and `ItemsSearch` prop types so `onOpenItem: (id: number, row: ItemRow) => void`. In `ItemsBrowse.tsx`, the row-click handler becomes:

```typescript
<button className="flex-1 text-left" onClick={() => onOpenItem(r.id, r)}>{r.title}</button>
```

In `ItemsSearch.tsx`, it forwards through to `ItemsBrowse` unchanged (since `ItemsBrowse` is the one rendering rows).

Update the corresponding test types (`ItemsBrowse.test.tsx` and `ItemsSearch.test.tsx`) — the `onOpenItem` mock now receives `(id, row)`. Adjust assertions:

```typescript
expect(onOpen).toHaveBeenCalledWith(1, expect.objectContaining({ id: 1 }))
```

- [ ] **Step 5: Run all frontend tests**

Run: `cd frontend && yarn test`

Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/pages/ItemsPage.tsx frontend/src/pages/ItemsPage.test.tsx frontend/src/components/items/
git commit -m "feat(items): add ItemsPage shell with tabs, filter chips, drawer wiring"
```

---

## Task 15: Frontend — Register `/items` route and sidebar entry

**Files:**
- Modify: `frontend/src/App.tsx`
- Modify: `frontend/src/components/Sidebar.tsx`

- [ ] **Step 1: Add the route**

In `frontend/src/App.tsx`, find the block of `<Route ... />` declarations (around line 41-70). Add the import alongside other page imports at the top:

```typescript
import { ItemsPage } from './pages/ItemsPage'
```

Add the route immediately after `<Route path="transactions" element={<TransactionsPage />} />`:

```tsx
<Route path="items" element={<ItemsPage />} />
```

- [ ] **Step 2: Add the sidebar entry**

In `frontend/src/components/Sidebar.tsx`, add `Package` to the lucide-react import (around line 3-22):

```typescript
import {
  // …existing imports…
  Package,
} from 'lucide-react'
```

Add the nav entry in the `navItems` array (around line 38), immediately after the `/transactions` entry:

```typescript
{ to: '/items', label: 'Items', icon: Package },
```

- [ ] **Step 3: Run the full frontend test suite**

Run: `cd frontend && yarn test`

Expected: all PASS. Sidebar already has no tests asserting count, so no test changes needed.

- [ ] **Step 4: Manual smoke test**

Run the dev server (verify the command — likely `yarn dev` from repo root or `yarn workspace frontend dev`):

```bash
yarn workspace frontend dev
```

Open `http://localhost:5173/items` (or whichever port Vite reports). Verify:

- Sidebar shows `Items` between `Transactions` and `Import`.
- `/items` renders the page with three tabs; Browse is default.
- Filter chip strip renders 5 chips above the table.
- Clicking a vendor chip → typing → Apply updates the URL and refetches.
- Browse renders empty state when no items exist (or grouped list if data exists).
- Switching to Search shows the search input + Export CSV button.
- Switching to Analyze shows "Coming soon".
- Clicking an item row opens the drawer with allocation panel.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/App.tsx frontend/src/components/Sidebar.tsx
git commit -m "feat(items): register /items route and sidebar nav entry"
```

---

## Task 16: Final verification

- [ ] **Step 1: Run full backend test suite**

```bash
cd backend && yarn test && yarn test:integration
```

Expected: all PASS (existing 652 + new ~12).

- [ ] **Step 2: Run full frontend test suite**

```bash
cd frontend && yarn test
```

Expected: all PASS (existing 121 + new ~20).

- [ ] **Step 3: Run typecheck**

```bash
yarn workspace backend run tsc --noEmit
yarn workspace frontend run tsc --noEmit
```

Expected: no errors.

- [ ] **Step 4: Manual end-to-end smoke test**

Run dev servers (backend + frontend). With at least one parsed receipt with line items, exercise:

1. Navigate to `/items` via sidebar.
2. Browse tab shows grouped-by-receipt list.
3. Toggle group-by to category → list regroups.
4. Toggle group-by to none → flat list.
5. Click a vendor chip → enter vendor → Apply → URL updates, list refetches.
6. Click an item row → drawer opens with allocation, Esc closes.
7. Edit category in drawer → Save → row updates (after PR-A future polish).
8. Multi-select 2-3 items → toolbar appears → bulk set category → toolbar clears.
9. Switch to Search → type "USB" → debounced query fires.
10. Click Export CSV → file downloads with filtered rows.
11. Switch to Analyze → see "Coming soon".

- [ ] **Step 5: Push branch + open PR**

```bash
git push -u origin claude/sad-gauss-d264f4
gh pr create --title "feat(items): first-class Items tab (PR-A: Browse + Search + drawer + bulk edit)" --body "$(cat <<'EOF'
## Summary

- Adds first-class `/items` page with Browse and Search subtabs
- Per-item detail drawer with allocation breakdown
- Multi-select bulk recategorization
- CSV export of filtered results
- Sidebar entry between Transactions and Import

Implements PR-A of [docs/superpowers/specs/2026-05-24-receipt-items-tab-design.md](docs/superpowers/specs/2026-05-24-receipt-items-tab-design.md). Analyze tab is a "Coming soon" placeholder until PR-B.

## Test plan

- [x] Backend integration tests (`yarn test:integration` in `backend/`)
- [x] Frontend unit tests (`yarn test` in `frontend/`)
- [x] Manual smoke: nav, filter chips, group-by toggle, drawer open/close, bulk edit, CSV export, search debounce
EOF
)"
```

---

## Self-Review Notes

**Spec coverage:**
- Browse + filter chips + multi-select + infinite scroll → Tasks 9, 10, 12, 14, 15
- Search + debounced query + CSV export → Tasks 6, 13, 14
- ItemDetailDrawer + allocation → Tasks 8, 11
- Per-item edit (reuse existing PATCH) → Task 11 (uses `PATCH /api/external-order-items/:id`)
- Bulk edit → Tasks 7, 12
- Backend filters, pagination, scope → Tasks 2-7
- Sidebar nav + route → Task 15
- Analyze "Coming soon" → Task 14

**Placeholders / open items:**
- The frame-template note in Task 2 about Sequelize association aliases needs verification at implementation time — the executing agent should read `backend/src/models/index.ts` once before writing the include clause and adjust `as:` keys to match.
- The cursor design simplifies to single-key `(itemId ASC)` in Task 5 — acceptable trade-off for PR-A given the simpler sort order shown in the spec.
- Postgres vs SQLite `LIKE` case-sensitivity noted inline; verify which DB the test+prod environments use before merging.

**Type consistency:**
- `ItemRow.businessUseEffective` is `boolean` everywhere.
- `ItemRow.businessUseOverride` is `boolean | null` on the wire (mapped from DB `'100' | '0' | null` string).
- The bulk-patch endpoint accepts `businessUseOverride: boolean | null` and writes the string form internally.
- `ItemAllocation.allocatedTotal` is `number | null`; null means unlinked.
- `useItemsQuery` returns `{ items, nextCursor, loading, error, fetchMore }` consistently across all callers.

---

## Execution Handoff

Plan complete. Recommended execution: **subagent-driven-development** (fresh subagent per task with review between tasks). Inline execution is also fine if the user prefers fewer context handoffs.
