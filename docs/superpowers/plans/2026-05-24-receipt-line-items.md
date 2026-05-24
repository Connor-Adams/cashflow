# Receipt Line Items Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add first-class viewing of receipt line items, per-item category overrides, and report rollup so dashboard/budget figures reflect every dollar from each receipt.

**Architecture:** Add `Receipt.externalOrderId` FK + `ExternalOrderItem.categoryOverride/businessUseOverride` to bridge the file-attached and structured receipt paths. Unify vision pipelines so `/api/receipts/:id/analyze` produces full `ExternalOrder` + items. New pure function `splitTxnByItems` allocates each linked transaction's amount across its items (with pro-rated tax/shipping), feeding the dashboard, monthly-budget, and review aggregators. Frontend gains a `ReceiptItemsDrawer` rendered from the existing transactions page.

**Tech Stack:** TypeScript, Sequelize (sqlite/Postgres), Express, React, Vitest. Existing `extractReceiptFromImage` (OpenAI vision) and `persistExtractedOrder` are reused; the only new AI surface is exposing the existing extractor through the receipt-analyze route.

**Spec:** [docs/superpowers/specs/2026-05-24-receipt-line-items-design.md](../specs/2026-05-24-receipt-line-items-design.md)

---

## File Map

**Backend — new files**

- `backend/src/migrations/20260524000001-receipt-item-overrides.js` — adds 3 columns.
- `backend/src/import/splitTxnByItems.ts` — pure allocation function.
- `backend/test/splitTxnByItems.test.ts` — unit tests for the allocator.
- `backend/test/integration/receiptAnalyzeItems.test.ts` — analyze-endpoint switch.
- `backend/test/integration/itemOverride.test.ts` — PATCH override route.
- `backend/test/integration/dashboardWithItems.test.ts` — dashboard rollup with items.
- `backend/test/integration/transactionReceiptsWithItems.test.ts` — GET receipts includes items.

**Backend — modified files**

- `backend/src/models/Receipt.ts` — add `externalOrderId` field.
- `backend/src/models/ExternalOrderItem.ts` — add `categoryOverride` + `businessUseOverride`.
- `backend/src/models/index.ts` — add `Receipt ↔ ExternalOrder` associations.
- `backend/src/routes/receipts.ts` — swap analyze impl, extend GET, add PATCH item route.
- `backend/src/summary/aggregateDashboard.ts` — feed allocations into category buckets.
- `backend/src/routes/budgets.ts` — `aggregateSpendByCategory` consumes allocations.
- `shared/api-types.ts` — receipt response includes `externalOrderId`, `order`, `items[]`.

**Frontend — new files**

- `frontend/src/components/ReceiptItemsDrawer.tsx` — per-receipt items + override UI.
- `frontend/src/components/ReceiptItemsDrawer.test.tsx` — drawer tests.

**Frontend — modified files**

- `frontend/src/pages/TransactionsPage.tsx` — wire "View items" entry point + drawer state.

---

## Conventions

- Commit after every passing step that touches code. Use Conventional Commits (`feat`, `fix`, `refactor`, `test`, `docs`, `chore`). Repo convention permits short scopes (`feat(receipts):`, `refactor(summary):`).
- **Never add a `Co-Authored-By` line.** Sole author is the human user.
- Backend tests run with: `yarn workspace backend test -- <pattern>` (Vitest).
- Frontend tests run with: `yarn workspace frontend test -- <pattern>` (Vitest + jsdom).
- Migration round-trip check: `yarn workspace backend sequelize db:migrate` then `db:migrate:undo` in a scratch sqlite. Plan uses model `sync({force:true})` against the in-memory test DB instead — the integration tests exercise the columns implicitly.
- All new DB columns are nullable with no default. Adding a column = additive; aggregator stays a no-op on rows missing item links.

---

## Task 1: Migration — three new columns

**Files:**
- Create: `backend/src/migrations/20260524000001-receipt-item-overrides.js`

- [ ] **Step 1: Write the migration**

```js
'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('receipts', 'external_order_id', {
      type: Sequelize.INTEGER,
      allowNull: true,
      references: { model: 'external_orders', key: 'id' },
      onUpdate: 'CASCADE',
      onDelete: 'SET NULL',
    });
    await queryInterface.addIndex('receipts', ['external_order_id'], {
      name: 'receipts_external_order_id',
    });
    await queryInterface.addColumn('external_order_items', 'category_override', {
      type: Sequelize.STRING(128),
      allowNull: true,
    });
    await queryInterface.addColumn('external_order_items', 'business_use_override', {
      type: Sequelize.DECIMAL(5, 2),
      allowNull: true,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('external_order_items', 'business_use_override');
    await queryInterface.removeColumn('external_order_items', 'category_override');
    await queryInterface.removeIndex('receipts', 'receipts_external_order_id');
    await queryInterface.removeColumn('receipts', 'external_order_id');
  },
};
```

- [ ] **Step 2: Verify integration test DB picks up the migration**

The backend test harness applies migrations via `sequelize.sync({force:true})` against models. Migration files only run in real environments. Confirm by running an empty test (no assertions yet):

Run: `yarn workspace backend test -- backend/test/integration/transactions.test.ts -t "should list"`
Expected: PASS (existing tests still green).

- [ ] **Step 3: Commit**

```bash
git add backend/src/migrations/20260524000001-receipt-item-overrides.js
git commit -m "feat(receipts): migration for external_order_id + item overrides"
```

---

## Task 2: Model — Receipt.externalOrderId

**Files:**
- Modify: `backend/src/models/Receipt.ts`

- [ ] **Step 1: Add field declaration and init**

Edit `backend/src/models/Receipt.ts`:

After `declare extractedNote: string | null;`, add:

```ts
  declare externalOrderId: number | null;
```

Inside the `Receipt.init({...})` attribute block, after the `extractedNote` entry, add:

```ts
      externalOrderId: {
        type: DataTypes.INTEGER,
        field: 'external_order_id',
        allowNull: true,
      },
```

- [ ] **Step 2: Verify backend typechecks**

Run: `yarn workspace backend tsc --noEmit`
Expected: PASS (no new type errors).

- [ ] **Step 3: Commit**

```bash
git add backend/src/models/Receipt.ts
git commit -m "feat(receipts): Receipt.externalOrderId field"
```

---

## Task 3: Model — ExternalOrderItem override fields

**Files:**
- Modify: `backend/src/models/ExternalOrderItem.ts`

- [ ] **Step 1: Add declarations and init**

Edit `backend/src/models/ExternalOrderItem.ts`. After `declare confidence: string | null;`, add:

```ts
  declare categoryOverride: string | null;
  declare businessUseOverride: string | null;
```

Inside the init attributes block, after the `confidence` entry, add:

```ts
      categoryOverride: {
        type: DataTypes.STRING(128),
        field: 'category_override',
        allowNull: true,
      },
      businessUseOverride: {
        type: DataTypes.DECIMAL(5, 2),
        field: 'business_use_override',
        allowNull: true,
      },
```

- [ ] **Step 2: Typecheck**

Run: `yarn workspace backend tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add backend/src/models/ExternalOrderItem.ts
git commit -m "feat(receipts): ExternalOrderItem category/business override fields"
```

---

## Task 4: Associations — Receipt ↔ ExternalOrder

**Files:**
- Modify: `backend/src/models/index.ts`

- [ ] **Step 1: Add belongsTo / hasMany**

Find the existing `Receipt` association block in `backend/src/models/index.ts` (search for `Receipt.belongsTo(Transaction`). After the existing Receipt block, add:

```ts
Receipt.belongsTo(ExternalOrder, {
  as: 'externalOrder',
  foreignKey: 'externalOrderId',
});
ExternalOrder.hasMany(Receipt, {
  as: 'receipts',
  foreignKey: 'externalOrderId',
});
```

If `ExternalOrder` is not already imported at the top of the file, ensure the existing import line includes it (it is, per current code).

- [ ] **Step 2: Typecheck**

Run: `yarn workspace backend tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Smoke-test association**

Run: `yarn workspace backend test -- backend/test/integration/transactions.test.ts -t "should list"`
Expected: PASS (no regressions).

- [ ] **Step 4: Commit**

```bash
git add backend/src/models/index.ts
git commit -m "feat(receipts): associate Receipt with ExternalOrder"
```

---

## Task 5: Write failing splitTxnByItems tests

**Files:**
- Create: `backend/test/splitTxnByItems.test.ts`

- [ ] **Step 1: Write the test file**

Create `backend/test/splitTxnByItems.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { splitTxnByItems, type AllocatorInput } from '../src/import/splitTxnByItems';

function input(overrides: Partial<AllocatorInput>): AllocatorInput {
  return {
    txn: {
      id: 1,
      amount: '-100.00',
      currency: 'CAD',
      finalCategory: 'Shopping',
      finalBusiness: false,
      finalSplitType: 'me',
      businessAmount: '0',
    },
    links: [],
    ordersById: new Map(),
    itemsByOrder: new Map(),
    ...overrides,
  };
}

describe('splitTxnByItems', () => {
  it('returns single bucket when no links exist', () => {
    const out = splitTxnByItems(input({}));
    expect(out).toEqual([
      {
        category: 'Shopping',
        amount: -100,
        businessAmount: 0,
        currency: 'CAD',
      },
    ]);
  });

  it('allocates items by totalPrice and prorates tax', () => {
    const ordersById = new Map([
      [
        10,
        {
          id: 10,
          subtotal: '90.00',
          tax: '10.00',
          shipping: null,
          total: '100.00',
          currency: 'CAD',
        },
      ],
    ]);
    const itemsByOrder = new Map([
      [
        10,
        [
          {
            id: 1,
            totalPrice: '60.00',
            unitPrice: null,
            quantity: 1,
            inferredCategory: 'Groceries',
            categoryOverride: null,
            businessUsePercent: null,
            businessUseOverride: null,
          },
          {
            id: 2,
            totalPrice: '30.00',
            unitPrice: null,
            quantity: 1,
            inferredCategory: 'Household',
            categoryOverride: null,
            businessUsePercent: null,
            businessUseOverride: null,
          },
        ],
      ],
    ]);
    const out = splitTxnByItems(
      input({
        links: [{ externalOrderId: 10, linkedAmount: null }],
        ordersById,
        itemsByOrder,
      }),
    );
    // item1 share 60/90, gets 60 + (60/90 * 10) = 66.67
    // item2 share 30/90, gets 30 + (30/90 * 10) = 33.33
    // signed negative
    expect(out).toHaveLength(2);
    const groceries = out.find((a) => a.category === 'Groceries');
    const household = out.find((a) => a.category === 'Household');
    expect(groceries?.amount).toBeCloseTo(-66.67, 1);
    expect(household?.amount).toBeCloseTo(-33.33, 1);
    expect(out.reduce((s, a) => s + a.amount, 0)).toBeCloseTo(-100, 1);
  });

  it('uses categoryOverride > inferredCategory > txn.category', () => {
    const ordersById = new Map([
      [
        10,
        {
          id: 10,
          subtotal: '50.00',
          tax: null,
          shipping: null,
          total: '50.00',
          currency: 'CAD',
        },
      ],
    ]);
    const itemsByOrder = new Map([
      [
        10,
        [
          {
            id: 1,
            totalPrice: '20.00',
            unitPrice: null,
            quantity: 1,
            inferredCategory: 'Groceries',
            categoryOverride: 'Household',
            businessUsePercent: null,
            businessUseOverride: null,
          },
          {
            id: 2,
            totalPrice: '15.00',
            unitPrice: null,
            quantity: 1,
            inferredCategory: 'Snacks',
            categoryOverride: null,
            businessUsePercent: null,
            businessUseOverride: null,
          },
          {
            id: 3,
            totalPrice: '15.00',
            unitPrice: null,
            quantity: 1,
            inferredCategory: null,
            categoryOverride: null,
            businessUsePercent: null,
            businessUseOverride: null,
          },
        ],
      ],
    ]);
    const out = splitTxnByItems(
      input({
        txn: {
          id: 1,
          amount: '-50.00',
          currency: 'CAD',
          finalCategory: 'Shopping',
          finalBusiness: false,
          finalSplitType: 'me',
          businessAmount: '0',
        },
        links: [{ externalOrderId: 10, linkedAmount: null }],
        ordersById,
        itemsByOrder,
      }),
    );
    const cats = new Set(out.map((a) => a.category));
    expect(cats.has('Household')).toBe(true); // override
    expect(cats.has('Snacks')).toBe(true); // inferred
    expect(cats.has('Shopping')).toBe(true); // fallback to txn.category
  });

  it('scales allocations by linkedAmount for split-tender', () => {
    const ordersById = new Map([
      [
        10,
        {
          id: 10,
          subtotal: '100.00',
          tax: null,
          shipping: null,
          total: '100.00',
          currency: 'CAD',
        },
      ],
    ]);
    const itemsByOrder = new Map([
      [
        10,
        [
          {
            id: 1,
            totalPrice: '100.00',
            unitPrice: null,
            quantity: 1,
            inferredCategory: 'Groceries',
            categoryOverride: null,
            businessUsePercent: null,
            businessUseOverride: null,
          },
        ],
      ],
    ]);
    const out = splitTxnByItems(
      input({
        txn: {
          id: 1,
          amount: '-60.00',
          currency: 'CAD',
          finalCategory: 'Shopping',
          finalBusiness: false,
          finalSplitType: 'me',
          businessAmount: '0',
        },
        links: [{ externalOrderId: 10, linkedAmount: '60.00' }],
        ordersById,
        itemsByOrder,
      }),
    );
    expect(out).toHaveLength(1);
    expect(out[0].amount).toBeCloseTo(-60, 1);
    expect(out[0].category).toBe('Groceries');
  });

  it('lumps drift into a txn.category bucket', () => {
    const ordersById = new Map([
      [
        10,
        {
          id: 10,
          subtotal: '95.00',
          tax: null,
          shipping: null,
          total: '100.00',
          currency: 'CAD',
        },
      ],
    ]);
    const itemsByOrder = new Map([
      [
        10,
        [
          {
            id: 1,
            totalPrice: '95.00',
            unitPrice: null,
            quantity: 1,
            inferredCategory: 'Groceries',
            categoryOverride: null,
            businessUsePercent: null,
            businessUseOverride: null,
          },
        ],
      ],
    ]);
    const out = splitTxnByItems(
      input({
        links: [{ externalOrderId: 10, linkedAmount: null }],
        ordersById,
        itemsByOrder,
      }),
    );
    expect(out.reduce((s, a) => s + a.amount, 0)).toBeCloseTo(-100, 1);
    expect(out.find((a) => a.category === 'Shopping')?.amount).toBeCloseTo(-5, 1);
    expect(out.find((a) => a.category === 'Groceries')?.amount).toBeCloseTo(-95, 1);
  });

  it('applies businessUseOverride to businessAmount per allocation', () => {
    const ordersById = new Map([
      [
        10,
        {
          id: 10,
          subtotal: '100.00',
          tax: null,
          shipping: null,
          total: '100.00',
          currency: 'CAD',
        },
      ],
    ]);
    const itemsByOrder = new Map([
      [
        10,
        [
          {
            id: 1,
            totalPrice: '100.00',
            unitPrice: null,
            quantity: 1,
            inferredCategory: 'Office',
            categoryOverride: null,
            businessUsePercent: null,
            businessUseOverride: '50.00',
          },
        ],
      ],
    ]);
    const out = splitTxnByItems(
      input({
        links: [{ externalOrderId: 10, linkedAmount: null }],
        ordersById,
        itemsByOrder,
      }),
    );
    expect(out[0].businessAmount).toBeCloseTo(-50, 1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn workspace backend test -- backend/test/splitTxnByItems.test.ts`
Expected: FAIL — module `../src/import/splitTxnByItems` not found.

- [ ] **Step 3: Commit (red)**

```bash
git add backend/test/splitTxnByItems.test.ts
git commit -m "test(receipts): failing tests for splitTxnByItems allocator"
```

---

## Task 6: Implement splitTxnByItems

**Files:**
- Create: `backend/src/import/splitTxnByItems.ts`

- [ ] **Step 1: Implement**

Create `backend/src/import/splitTxnByItems.ts`:

```ts
import { logger } from '../observability/logger';

export type AllocatorTxn = {
  id: number;
  amount: string;
  currency: string;
  finalCategory: string | null;
  finalBusiness: boolean;
  finalSplitType: string;
  businessAmount: string;
};

export type AllocatorLink = {
  externalOrderId: number;
  linkedAmount: string | null;
};

export type AllocatorOrder = {
  id: number;
  subtotal: string | null;
  tax: string | null;
  shipping: string | null;
  total: string | null;
  currency: string;
};

export type AllocatorItem = {
  id: number;
  totalPrice: string | null;
  unitPrice: string | null;
  quantity: number;
  inferredCategory: string | null;
  categoryOverride: string | null;
  businessUsePercent: string | null;
  businessUseOverride: string | null;
};

export type AllocatorInput = {
  txn: AllocatorTxn;
  links: AllocatorLink[];
  ordersById: Map<number, AllocatorOrder>;
  itemsByOrder: Map<number, AllocatorItem[]>;
};

export type CategoryAllocation = {
  category: string | null;
  amount: number;
  businessAmount: number;
  currency: string;
};

function n(v: string | null): number {
  if (v == null || v === '') return 0;
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
}

function itemBase(item: AllocatorItem): number {
  if (item.totalPrice != null) return n(item.totalPrice);
  if (item.unitPrice != null) return n(item.unitPrice) * (item.quantity || 1);
  return 0;
}

function effectiveCategory(item: AllocatorItem, txnCategory: string | null): string | null {
  return item.categoryOverride ?? item.inferredCategory ?? txnCategory;
}

function effectiveBusinessPct(item: AllocatorItem): number {
  const ov = item.businessUseOverride;
  if (ov != null) return n(ov);
  return n(item.businessUsePercent);
}

export function splitTxnByItems(input: AllocatorInput): CategoryAllocation[] {
  const { txn, links, ordersById, itemsByOrder } = input;
  const txnAmount = n(txn.amount);
  const sign = txnAmount < 0 ? -1 : 1;
  const txnAbs = Math.abs(txnAmount);

  // No useful link data → single fallback bucket = txn.category, txn.amount.
  const usable = links.filter((l) => {
    const order = ordersById.get(l.externalOrderId);
    const items = itemsByOrder.get(l.externalOrderId);
    return order != null && items != null && items.length > 0;
  });
  if (usable.length === 0) {
    return [
      {
        category: txn.finalCategory,
        amount: txnAmount,
        businessAmount: n(txn.businessAmount) * sign,
        currency: txn.currency,
      },
    ];
  }

  const bucket = new Map<string, CategoryAllocation>();
  const add = (cat: string | null, amount: number, businessAmount: number) => {
    const key = cat ?? '';
    const existing = bucket.get(key);
    if (existing) {
      existing.amount += amount;
      existing.businessAmount += businessAmount;
    } else {
      bucket.set(key, {
        category: cat,
        amount,
        businessAmount,
        currency: txn.currency,
      });
    }
  };

  let allocated = 0;
  for (const link of usable) {
    const order = ordersById.get(link.externalOrderId)!;
    const items = itemsByOrder.get(link.externalOrderId)!;
    const orderTotal = n(order.total);
    const linkAmt = link.linkedAmount != null ? n(link.linkedAmount) : orderTotal;
    const share = orderTotal > 0 ? linkAmt / orderTotal : 1;

    const baseSum = items.reduce((s, it) => s + itemBase(it), 0);
    const extras = (n(order.tax) + n(order.shipping)) * share;

    if (baseSum <= 0) {
      // No item prices known — split evenly across known categories.
      const portion = linkAmt / items.length;
      for (const it of items) {
        const cat = effectiveCategory(it, txn.finalCategory);
        const biz = (effectiveBusinessPct(it) / 100) * portion;
        add(cat, portion * sign, biz * sign);
        allocated += portion;
      }
      continue;
    }

    for (const it of items) {
      const base = itemBase(it) * share;
      const weight = base / baseSum;
      const portion = base + extras * weight;
      const cat = effectiveCategory(it, txn.finalCategory);
      const biz = (effectiveBusinessPct(it) / 100) * portion;
      add(cat, portion * sign, biz * sign);
      allocated += portion;
    }
  }

  const drift = txnAbs - allocated;
  if (Math.abs(drift) >= 0.005) {
    logger.info('split_txn_drift', {
      txnId: txn.id,
      expected: txnAbs,
      computed: allocated,
      drift,
    });
    add(txn.finalCategory, drift * sign, 0);
  }

  return Array.from(bucket.values());
}
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `yarn workspace backend test -- backend/test/splitTxnByItems.test.ts`
Expected: PASS (all 6 tests).

- [ ] **Step 3: Commit (green)**

```bash
git add backend/src/import/splitTxnByItems.ts
git commit -m "feat(receipts): splitTxnByItems allocator with pro-rated tax/shipping"
```

---

## Task 7: Aggregator loader helper

**Files:**
- Create: `backend/src/summary/loadItemAllocations.ts`
- Create: `backend/test/loadItemAllocations.test.ts`

- [ ] **Step 1: Write failing test**

Create `backend/test/loadItemAllocations.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sequelize, ExternalOrder, ExternalOrderItem, TransactionOrderLink } from '../src/models';
import { loadItemAllocationContext } from '../src/summary/loadItemAllocations';

beforeAll(async () => {
  await sequelize.sync({ force: true });
});
afterAll(async () => {
  await sequelize.close();
});

describe('loadItemAllocationContext', () => {
  it('returns empty maps when no txn ids', async () => {
    const ctx = await loadItemAllocationContext([]);
    expect(ctx.linksByTxn.size).toBe(0);
    expect(ctx.ordersById.size).toBe(0);
    expect(ctx.itemsByOrder.size).toBe(0);
  });

  it('returns maps keyed by txn id / order id', async () => {
    const order = await ExternalOrder.create({
      vendor: 'costco',
      dedupeKey: 'k1',
      total: '100.00',
      subtotal: '90.00',
      tax: '10.00',
      currency: 'CAD',
      source: 'test',
    } as never);
    await ExternalOrderItem.create({
      externalOrderId: order.id,
      title: 'Eggs',
      quantity: 1,
      totalPrice: '90.00',
      inferredCategory: 'Groceries',
    } as never);
    await TransactionOrderLink.create({
      transactionId: 999,
      externalOrderId: order.id,
      confidence: '90',
      matchReason: 'test',
      status: 'confirmed',
      linkedAmount: '100.00',
    } as never);

    const ctx = await loadItemAllocationContext([999]);
    expect(ctx.linksByTxn.get(999)?.length).toBe(1);
    expect(ctx.ordersById.get(order.id)?.total).toBe('100.00');
    expect(ctx.itemsByOrder.get(order.id)?.[0]?.inferredCategory).toBe('Groceries');
  });
});
```

Run: `yarn workspace backend test -- backend/test/loadItemAllocations.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 2: Implement loader**

Create `backend/src/summary/loadItemAllocations.ts`:

```ts
import { Op } from 'sequelize';
import {
  ExternalOrder,
  ExternalOrderItem,
  TransactionOrderLink,
} from '../models';
import type {
  AllocatorLink,
  AllocatorOrder,
  AllocatorItem,
} from '../import/splitTxnByItems';

export type ItemAllocationContext = {
  linksByTxn: Map<number, AllocatorLink[]>;
  ordersById: Map<number, AllocatorOrder>;
  itemsByOrder: Map<number, AllocatorItem[]>;
};

export async function loadItemAllocationContext(
  txnIds: number[],
): Promise<ItemAllocationContext> {
  const empty: ItemAllocationContext = {
    linksByTxn: new Map(),
    ordersById: new Map(),
    itemsByOrder: new Map(),
  };
  if (txnIds.length === 0) return empty;

  const links = await TransactionOrderLink.findAll({
    where: { transactionId: { [Op.in]: txnIds } },
  });
  if (links.length === 0) return empty;

  const orderIds = Array.from(new Set(links.map((l) => l.externalOrderId)));
  const [orders, items] = await Promise.all([
    ExternalOrder.findAll({ where: { id: { [Op.in]: orderIds } } }),
    ExternalOrderItem.findAll({ where: { externalOrderId: { [Op.in]: orderIds } } }),
  ]);

  const linksByTxn = new Map<number, AllocatorLink[]>();
  for (const l of links) {
    const list = linksByTxn.get(l.transactionId) ?? [];
    list.push({ externalOrderId: l.externalOrderId, linkedAmount: l.linkedAmount });
    linksByTxn.set(l.transactionId, list);
  }

  const ordersById = new Map<number, AllocatorOrder>();
  for (const o of orders) {
    ordersById.set(o.id, {
      id: o.id,
      subtotal: o.subtotal,
      tax: o.tax,
      shipping: o.shipping,
      total: o.total,
      currency: o.currency,
    });
  }

  const itemsByOrder = new Map<number, AllocatorItem[]>();
  for (const it of items) {
    const list = itemsByOrder.get(it.externalOrderId) ?? [];
    list.push({
      id: it.id,
      totalPrice: it.totalPrice,
      unitPrice: it.unitPrice,
      quantity: it.quantity,
      inferredCategory: it.inferredCategory,
      categoryOverride: it.categoryOverride,
      businessUsePercent: it.businessUsePercent,
      businessUseOverride: it.businessUseOverride,
    });
    itemsByOrder.set(it.externalOrderId, list);
  }

  return { linksByTxn, ordersById, itemsByOrder };
}
```

- [ ] **Step 3: Run tests to verify pass**

Run: `yarn workspace backend test -- backend/test/loadItemAllocations.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add backend/src/summary/loadItemAllocations.ts backend/test/loadItemAllocations.test.ts
git commit -m "feat(receipts): loadItemAllocationContext helper for aggregators"
```

---

## Task 8: Integrate allocations into aggregateDashboard

**Files:**
- Modify: `backend/src/summary/aggregateDashboard.ts`
- Modify: `backend/test/aggregateDashboard.test.ts` (extend if exists; create if not)

- [ ] **Step 1: Extend aggregator signature**

Edit `backend/src/summary/aggregateDashboard.ts`. Add to the imports block:

```ts
import { splitTxnByItems } from '../import/splitTxnByItems';
import type { ItemAllocationContext } from './loadItemAllocations';
```

Extend `SummaryTxnRow` type by adding the fields the allocator needs (after `txnType: string | null;`):

```ts
  amountRaw?: string; // optional; aggregator falls back to existing `amount` parsing
  businessAmount?: string;
```

(If `Transaction.findAll` doesn't already pass `businessAmount`, leave the field optional and treat undefined as `'0'` in the call site.)

Change the function signature:

```ts
export function aggregateDashboard(
  rows: SummaryTxnRow[],
  accountById: Map<number, AccountRow>,
  itemContext?: ItemAllocationContext,
): DashboardAggregates {
```

- [ ] **Step 2: Use allocations for the two category-keyed buckets**

Inside the per-row loop, **replace** the existing `byCategory` block (lines around 297-311 in `aggregateDashboard.ts`) with allocations-aware logic. Find:

```ts
    const key = [
      row.currency,
      row.finalCategory ?? '',
      row.finalBusiness ? '1' : '0',
      row.finalSplitType,
    ].join('\0');
    const existing = byCategory.get(key) ?? {
      currency: row.currency,
      category: row.finalCategory,
      finalBusiness: row.finalBusiness,
      finalSplitType: row.finalSplitType,
      sumAmount: 0,
    };
    existing.sumAmount += amount;
    byCategory.set(key, existing);
```

Replace with:

```ts
    const allocations = itemContext
      ? splitTxnByItems({
          txn: {
            id: row.id,
            amount: String(row.amount),
            currency: row.currency,
            finalCategory: row.finalCategory,
            finalBusiness: row.finalBusiness,
            finalSplitType: row.finalSplitType,
            businessAmount: row.businessAmount ?? '0',
          },
          links: itemContext.linksByTxn.get(row.id) ?? [],
          ordersById: itemContext.ordersById,
          itemsByOrder: itemContext.itemsByOrder,
        })
      : [
          {
            category: row.finalCategory,
            amount,
            businessAmount: 0,
            currency: row.currency,
          },
        ];

    for (const alloc of allocations) {
      const key = [
        row.currency,
        alloc.category ?? '',
        row.finalBusiness ? '1' : '0',
        row.finalSplitType,
      ].join('\0');
      const existing = byCategory.get(key) ?? {
        currency: row.currency,
        category: alloc.category,
        finalBusiness: row.finalBusiness,
        finalSplitType: row.finalSplitType,
        sumAmount: 0,
      };
      existing.sumAmount += alloc.amount;
      byCategory.set(key, existing);
    }
```

Then in the lower block, replace the single `category` update (lines around 338-345 and 352, 357, 366, 370):

Find:

```ts
    const categoryKey = `${currency}\0${row.finalCategory ?? ''}`;
    const category = categoryReports.get(categoryKey) ?? {
      currency,
      category: row.finalCategory,
      totalSpend: 0,
      totalCredits: 0,
      netSpend: 0,
    };
```

And the subsequent block that adds to `category.totalSpend` / `category.totalCredits`. Replace the categoryReports update with a per-allocation loop:

```ts
    for (const alloc of allocations) {
      const categoryKey = `${currency}\0${alloc.category ?? ''}`;
      const category = categoryReports.get(categoryKey) ?? {
        currency,
        category: alloc.category,
        totalSpend: 0,
        totalCredits: 0,
        netSpend: 0,
      };
      if (alloc.amount < 0 && !nonSpend) {
        category.totalSpend += -alloc.amount;
      } else if (alloc.amount > 0) {
        category.totalCredits += alloc.amount;
      }
      category.netSpend = category.totalSpend - category.totalCredits;
      categoryReports.set(categoryKey, category);
    }
```

Remove the old single `category.totalSpend += spend;` / `category.totalCredits += amount;` lines and the final `categoryReports.set(categoryKey, category);` outside this loop. **Keep** the `monthly`, `split`, `business` accumulations using the original `amount` — those are not category-keyed.

- [ ] **Step 3: Update route call site**

Edit `backend/src/routes/summary.ts`. Find the `aggregateDashboard(rows, accountById)` call. Above it, add:

```ts
import { loadItemAllocationContext } from '../summary/loadItemAllocations';
```

Replace the call:

```ts
const itemContext = await loadItemAllocationContext(rows.map((r) => r.id));
const aggregates = aggregateDashboard(rows, accountById, itemContext);
```

- [ ] **Step 4: Run existing dashboard tests**

Run: `yarn workspace backend test -- backend/test/aggregateDashboard.test.ts`
Expected: PASS (no items in fixtures → allocations are fallback singletons; sums unchanged).

If the test file doesn't exist, run the integration tests that touch the dashboard:
Run: `yarn workspace backend test -- backend/test/integration/wsSpendDashboard.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/summary/aggregateDashboard.ts backend/src/routes/summary.ts
git commit -m "feat(summary): per-item allocations in dashboard category buckets"
```

---

## Task 9: Integrate allocations into aggregateSpendByCategory

**Files:**
- Modify: `backend/src/routes/budgets.ts`

- [ ] **Step 1: Extend signature and use allocations**

Edit `backend/src/routes/budgets.ts`. Add at the top of the file:

```ts
import { splitTxnByItems } from '../import/splitTxnByItems';
import { loadItemAllocationContext, type ItemAllocationContext } from '../summary/loadItemAllocations';
```

Change the `SpendRow` type around line 216:

```ts
type SpendRow = {
  id: number;
  currency: string;
  finalCategory: string | null;
  finalBusiness: boolean;
  finalSplitType: string;
  amount: unknown;
  businessAmount: string;
};
```

Change `aggregateSpendByCategory` signature:

```ts
export function aggregateSpendByCategory(
  rows: SpendRow[],
  itemContext?: ItemAllocationContext,
): Map<string, { currency: string; category: string | null; spent: number }> {
```

Replace the body:

```ts
  const out = new Map<
    string,
    { currency: string; category: string | null; spent: number }
  >();
  for (const row of rows) {
    const amount = num(row.amount);
    if (amount == null || amount >= 0) continue;
    const allocations = itemContext
      ? splitTxnByItems({
          txn: {
            id: row.id,
            amount: String(row.amount),
            currency: row.currency,
            finalCategory: row.finalCategory,
            finalBusiness: row.finalBusiness,
            finalSplitType: row.finalSplitType,
            businessAmount: row.businessAmount,
          },
          links: itemContext.linksByTxn.get(row.id) ?? [],
          ordersById: itemContext.ordersById,
          itemsByOrder: itemContext.itemsByOrder,
        })
      : [
          {
            category: row.finalCategory,
            amount,
            businessAmount: 0,
            currency: row.currency,
          },
        ];
    for (const alloc of allocations) {
      if (alloc.amount >= 0) continue;
      const spend = -alloc.amount;
      const key = `${alloc.currency}\0${alloc.category ?? ''}`;
      const existing = out.get(key) ?? {
        currency: alloc.currency,
        category: alloc.category,
        spent: 0,
      };
      existing.spent += spend;
      out.set(key, existing);
    }
  }
  return out;
}
```

- [ ] **Step 2: Update route call sites**

Find every call to `aggregateSpendByCategory(rows)` in the file. Before each, add:

```ts
const itemContext = await loadItemAllocationContext(rows.map((r) => r.id));
```

Pass `itemContext` as the second arg. Also ensure the `Transaction.findAll({ attributes: [...] })` calls in this route include `id`, `finalBusiness`, `finalSplitType`, `businessAmount` — add them if missing.

- [ ] **Step 3: Run budget tests**

Run: `yarn workspace backend test -- backend/test/budgets.test.ts`
Expected: PASS (no items in fixtures → fallback to existing behavior).

- [ ] **Step 4: Commit**

```bash
git add backend/src/routes/budgets.ts
git commit -m "feat(budgets): per-item allocations in spend aggregation"
```

---

## Task 10: Swap analyze endpoint to items-extractor

**Files:**
- Modify: `backend/src/routes/receipts.ts`

- [ ] **Step 1: Locate the analyze handler**

Read `backend/src/routes/receipts.ts` lines 193-240 (the `POST /receipts/:id/analyze` block).

- [ ] **Step 2: Replace handler body**

Replace the handler body inside `router.post('/receipts/:id/analyze', aiSuggestLimiter, ...` with:

```ts
    try {
      if (rejectDemoAiRequest(req, res)) return;
      if (!getOpenAiConfig()) {
        res.status(503).json({ error: 'OpenAI is not configured' });
        return;
      }
      const id = parseInt(String(req.params.id), 10);
      if (Number.isNaN(id) || id < 1) {
        res.status(400).json({ error: 'Invalid id' });
        return;
      }
      const row = await Receipt.findByPk(id);
      if (!row) {
        res.status(404).json({ error: 'Not found' });
        return;
      }
      const txn = await Transaction.findOne({
        where: { id: row.transactionId, ...visibleTransactionWhere(req) },
      });
      if (!txn) {
        res.status(404).json({ error: 'Not found' });
        return;
      }
      const buf = await readReceiptObject(row.storedFilename);
      const mime = row.mimeType.toLowerCase();
      if (!mime.startsWith('image/')) {
        res.status(400).json({ error: 'Vision analysis supports image receipts only' });
        return;
      }
      const dataUrl = `data:${mime};base64,${buf.toString('base64')}`;
      const extracted = await extractReceiptFromImage(dataUrl);
      const auth = currentAuth(req);
      const { order } = await persistExtractedOrder(extracted, {
        userId: auth.user.id,
        householdId: auth.household.id,
        source: 'receipt-analyze',
      });
      await row.update({
        externalOrderId: order.id,
        extractedNote: JSON.stringify(extracted),
      });
      if (auth.household.id != null) {
        await matchReceiptOrderToTransactions({
          externalOrderId: order.id,
          householdId: auth.household.id,
        });
      }
      res.json({ receipt: row.toJSON(), order: order.toJSON(), extracted });
    } catch (e) {
      next(e);
    }
```

Add imports at the top of `receipts.ts`:

```ts
import { extractReceiptFromImage } from '../ai/extractReceiptItems';
import { persistExtractedOrder } from './externalOrders'; // see Step 3
import { matchReceiptOrderToTransactions } from '../import/matchReceiptToTransactions';
import { readReceiptObject } from '../storage/receiptStorage';
```

- [ ] **Step 3: Export persistExtractedOrder from externalOrders.ts**

Edit `backend/src/routes/externalOrders.ts`. Change:

```ts
async function persistExtractedOrder(
```

to:

```ts
export async function persistExtractedOrder(
```

- [ ] **Step 4: Remove unused imports**

After the swap, `receipts.ts` no longer needs `analyzeReceiptFileTracked` for the analyze handler. If the function is no longer referenced elsewhere in the file, remove its import. Leave `backend/src/ai/receiptVision.ts` in place — other code paths or tests may still touch it; deletion is a separate cleanup.

- [ ] **Step 5: Typecheck**

Run: `yarn workspace backend tsc --noEmit`
Expected: PASS.

- [ ] **Step 6: Run existing receipt tests**

Run: `yarn workspace backend test -- backend/test/integration/importPdfReceipt.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add backend/src/routes/receipts.ts backend/src/routes/externalOrders.ts
git commit -m "feat(receipts): analyze endpoint produces ExternalOrder + items"
```

---

## Task 11: Integration test for analyze switch

**Files:**
- Create: `backend/test/integration/receiptAnalyzeItems.test.ts`

- [ ] **Step 1: Write integration test**

Create `backend/test/integration/receiptAnalyzeItems.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setupTestApp, type TestApp } from '../helpers/setupTestApp';
import { writeReceiptObject } from '../../src/storage/receiptStorage';
import { Receipt, ExternalOrder, ExternalOrderItem, TransactionOrderLink } from '../../src/models';
import * as extractor from '../../src/ai/extractReceiptItems';

describe('POST /api/receipts/:id/analyze (items extraction)', () => {
  let app: TestApp;
  beforeEach(async () => {
    app = await setupTestApp();
  });

  it('persists ExternalOrder + items and links the receipt', async () => {
    vi.spyOn(extractor, 'extractReceiptFromImage').mockResolvedValue({
      vendor: 'costco',
      vendorName: 'Costco',
      orderDate: '2026-05-20',
      orderId: 'A123',
      subtotal: 90,
      tax: 10,
      total: 100,
      currency: 'CAD',
      paymentLast4: '1234',
      tenders: [],
      items: [
        {
          title: 'Eggs',
          quantity: 1,
          unitPrice: null,
          totalPrice: 60,
          inferredCategory: 'Groceries',
        },
        {
          title: 'Soap',
          quantity: 1,
          unitPrice: null,
          totalPrice: 30,
          inferredCategory: 'Household',
        },
      ],
      notes: null,
    });

    const txn = await app.factories.createTxn({
      merchantRaw: 'COSTCO',
      merchantClean: 'COSTCO',
      amount: '-100.00',
      date: '2026-05-20',
    });
    const stored = await writeReceiptObject(Buffer.from('fake-img'), 'image/png');
    const receipt = await Receipt.create({
      transactionId: txn.id,
      storedFilename: stored,
      originalName: 'r.png',
      mimeType: 'image/png',
      sizeBytes: 8,
      extractedNote: null,
    } as never);

    const res = await app.agent
      .post(`/api/receipts/${receipt.id}/analyze`)
      .send();
    expect(res.status).toBe(200);
    expect(res.body.order).toBeTruthy();
    expect(res.body.extracted.items).toHaveLength(2);

    const reloaded = await Receipt.findByPk(receipt.id);
    expect(reloaded?.externalOrderId).toBe(res.body.order.id);

    const order = await ExternalOrder.findByPk(res.body.order.id);
    expect(order?.total).toBe('100.0000');
    const items = await ExternalOrderItem.findAll({
      where: { externalOrderId: res.body.order.id },
    });
    expect(items).toHaveLength(2);

    const links = await TransactionOrderLink.findAll({
      where: { externalOrderId: res.body.order.id },
    });
    expect(links.length).toBeGreaterThan(0);
  });

  it('re-analyze on same receipt does not duplicate items (dedupe)', async () => {
    vi.spyOn(extractor, 'extractReceiptFromImage').mockResolvedValue({
      vendor: 'costco',
      vendorName: 'Costco',
      orderDate: '2026-05-20',
      orderId: 'A999',
      subtotal: 50,
      tax: 0,
      total: 50,
      currency: 'CAD',
      paymentLast4: null,
      tenders: [],
      items: [
        { title: 'Milk', quantity: 1, unitPrice: null, totalPrice: 50, inferredCategory: 'Groceries' },
      ],
      notes: null,
    });

    const txn = await app.factories.createTxn({ amount: '-50.00', date: '2026-05-20', merchantRaw: 'COSTCO', merchantClean: 'COSTCO' });
    const stored = await writeReceiptObject(Buffer.from('fake'), 'image/png');
    const receipt = await Receipt.create({
      transactionId: txn.id,
      storedFilename: stored,
      originalName: 'r.png',
      mimeType: 'image/png',
      sizeBytes: 4,
      extractedNote: null,
    } as never);

    const res1 = await app.agent.post(`/api/receipts/${receipt.id}/analyze`).send();
    const res2 = await app.agent.post(`/api/receipts/${receipt.id}/analyze`).send();
    expect(res1.body.order.id).toBe(res2.body.order.id);
    const items = await ExternalOrderItem.findAll({
      where: { externalOrderId: res1.body.order.id },
    });
    expect(items).toHaveLength(1);
  });

  it('returns 503 when OpenAI is not configured', async () => {
    delete process.env.OPENAI_API_KEY;
    const txn = await app.factories.createTxn({ amount: '-10.00', date: '2026-05-20' });
    const stored = await writeReceiptObject(Buffer.from('x'), 'image/png');
    const receipt = await Receipt.create({
      transactionId: txn.id,
      storedFilename: stored,
      originalName: 'r.png',
      mimeType: 'image/png',
      sizeBytes: 1,
      extractedNote: null,
    } as never);
    const res = await app.agent.post(`/api/receipts/${receipt.id}/analyze`).send();
    expect(res.status).toBe(503);
  });

  it('returns 404 when receipt belongs to another household', async () => {
    const other = await app.factories.createOtherHouseholdReceipt();
    const res = await app.agent.post(`/api/receipts/${other.id}/analyze`).send();
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: If helpers don't exist, adapt to existing test patterns**

If `setupTestApp` / `createTxn` / `createOtherHouseholdReceipt` factories don't match existing helpers in `backend/test/helpers/`, read `backend/test/helpers/*.ts` and update the test imports to use the actual helper names. Do not invent new helpers in this task.

Run: `yarn workspace backend test -- backend/test/integration/receiptAnalyzeItems.test.ts`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add backend/test/integration/receiptAnalyzeItems.test.ts
git commit -m "test(receipts): cover analyze endpoint items extraction + dedupe"
```

---

## Task 12: PATCH /api/external-order-items/:id route

**Files:**
- Modify: `backend/src/routes/receipts.ts` (or a new mount; keep co-located with other receipt routes)

- [ ] **Step 1: Add PATCH handler**

Append to `backend/src/routes/receipts.ts` (before `export default router;`):

```ts
router.patch('/external-order-items/:id', async (req, res, next) => {
  try {
    const id = parseInt(String(req.params.id), 10);
    if (Number.isNaN(id) || id < 1) {
      res.status(400).json({ error: 'Invalid id' });
      return;
    }
    const item = await ExternalOrderItem.findByPk(id);
    if (!item) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    const links = await TransactionOrderLink.findAll({
      where: { externalOrderId: item.externalOrderId },
    });
    if (links.length === 0) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    const txn = await Transaction.findOne({
      where: {
        id: { [Op.in]: links.map((l) => l.transactionId) },
        ...visibleTransactionWhere(req),
      },
    });
    if (!txn) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const patch: { categoryOverride?: string | null; businessUseOverride?: string | null } = {};
    if (Object.prototype.hasOwnProperty.call(body, 'categoryOverride')) {
      const v = body.categoryOverride;
      if (v === null || v === '') patch.categoryOverride = null;
      else if (typeof v === 'string') patch.categoryOverride = v;
      else {
        res.status(400).json({ error: 'categoryOverride must be string or null' });
        return;
      }
    }
    if (Object.prototype.hasOwnProperty.call(body, 'businessUseOverride')) {
      const v = body.businessUseOverride;
      if (v === null) patch.businessUseOverride = null;
      else {
        const n = Number(v);
        if (!Number.isFinite(n) || n < 0 || n > 100) {
          res.status(400).json({ error: 'businessUseOverride must be in [0,100]' });
          return;
        }
        patch.businessUseOverride = String(n);
      }
    }
    await item.update(patch);
    res.json(item.toJSON());
  } catch (e) {
    next(e);
  }
});
```

Ensure `Op` from `sequelize`, `ExternalOrderItem`, `TransactionOrderLink`, and `Transaction` are imported at the top of the file (add as needed).

- [ ] **Step 2: Mount the route**

`receipts.ts` is already mounted at `/api` in `app.ts` (see existing `/transactions/:transactionId/receipts` and `/receipts/:id/...`). Confirm the mount line in `backend/src/app.ts`:

```ts
app.use('/api', receiptsRouter);
```

If receipts is mounted under a more specific prefix, adjust the route to match. (Existing routes are mounted at `/api`, so `/external-order-items/:id` will resolve under `/api/external-order-items/:id`.)

- [ ] **Step 3: Typecheck**

Run: `yarn workspace backend tsc --noEmit`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add backend/src/routes/receipts.ts
git commit -m "feat(receipts): PATCH /api/external-order-items/:id for overrides"
```

---

## Task 13: Integration test for item PATCH

**Files:**
- Create: `backend/test/integration/itemOverride.test.ts`

- [ ] **Step 1: Write tests**

Create `backend/test/integration/itemOverride.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { setupTestApp, type TestApp } from '../helpers/setupTestApp';
import { ExternalOrder, ExternalOrderItem, TransactionOrderLink } from '../../src/models';

describe('PATCH /api/external-order-items/:id', () => {
  let app: TestApp;
  beforeEach(async () => {
    app = await setupTestApp();
  });

  async function seedItem(opts: { householdLinked: boolean }) {
    const order = await ExternalOrder.create({
      vendor: 'costco',
      dedupeKey: `k-${Date.now()}`,
      total: '50.00',
      currency: 'CAD',
      source: 'test',
    } as never);
    const item = await ExternalOrderItem.create({
      externalOrderId: order.id,
      title: 'Coffee',
      quantity: 1,
      totalPrice: '50.00',
      inferredCategory: 'Dining',
    } as never);
    if (opts.householdLinked) {
      const txn = await app.factories.createTxn({ amount: '-50.00', date: '2026-05-20' });
      await TransactionOrderLink.create({
        transactionId: txn.id,
        externalOrderId: order.id,
        confidence: '90',
        matchReason: 'test',
        status: 'confirmed',
      } as never);
    }
    return item;
  }

  it('updates categoryOverride', async () => {
    const item = await seedItem({ householdLinked: true });
    const res = await app.agent
      .patch(`/api/external-order-items/${item.id}`)
      .send({ categoryOverride: 'Groceries' });
    expect(res.status).toBe(200);
    expect(res.body.categoryOverride).toBe('Groceries');
  });

  it('returns 404 when item has no link in caller household', async () => {
    const item = await seedItem({ householdLinked: false });
    const res = await app.agent
      .patch(`/api/external-order-items/${item.id}`)
      .send({ categoryOverride: 'Groceries' });
    expect(res.status).toBe(404);
  });

  it('rejects businessUseOverride > 100', async () => {
    const item = await seedItem({ householdLinked: true });
    const res = await app.agent
      .patch(`/api/external-order-items/${item.id}`)
      .send({ businessUseOverride: 150 });
    expect(res.status).toBe(400);
  });

  it('accepts null to clear an override', async () => {
    const item = await seedItem({ householdLinked: true });
    await item.update({ categoryOverride: 'Groceries' });
    const res = await app.agent
      .patch(`/api/external-order-items/${item.id}`)
      .send({ categoryOverride: null });
    expect(res.status).toBe(200);
    expect(res.body.categoryOverride).toBeNull();
  });
});
```

- [ ] **Step 2: Adapt to existing helpers if necessary**

Same as Task 11 — confirm `setupTestApp` and `createTxn` factory shapes against `backend/test/helpers/`. Update import paths/names if needed.

- [ ] **Step 3: Run tests**

Run: `yarn workspace backend test -- backend/test/integration/itemOverride.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add backend/test/integration/itemOverride.test.ts
git commit -m "test(receipts): cover external_order_items PATCH route"
```

---

## Task 14: Extend GET receipts to include items

**Files:**
- Modify: `backend/src/routes/receipts.ts`
- Modify: `shared/api-types.ts`

- [ ] **Step 1: Extend the response type in shared**

Edit `shared/api-types.ts`. Find or add a `Receipt` response type. Add fields:

```ts
export type ExternalOrderItemView = {
  id: number;
  externalOrderId: number;
  title: string;
  quantity: number;
  unitPrice: string | null;
  totalPrice: string | null;
  inferredCategory: string | null;
  categoryOverride: string | null;
  businessUsePercent: string | null;
  businessUseOverride: string | null;
};

export type ExternalOrderView = {
  id: number;
  vendor: string;
  subtotal: string | null;
  tax: string | null;
  shipping: string | null;
  total: string | null;
  currency: string;
};

export type ReceiptWithItems = {
  id: number;
  transactionId: number;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  extractedNote: string | null;
  createdAt: string;
  externalOrderId: number | null;
  order: ExternalOrderView | null;
  items: ExternalOrderItemView[];
};
```

- [ ] **Step 2: Update the GET handler**

Edit `backend/src/routes/receipts.ts`. Replace the `GET /api/transactions/:transactionId/receipts` body with:

```ts
router.get('/transactions/:transactionId/receipts', async (req, res, next) => {
  try {
    const tid = parseInt(String(req.params.transactionId), 10);
    if (Number.isNaN(tid) || tid < 1) {
      res.status(400).json({ error: 'Invalid transaction id' });
      return;
    }
    const txn = await Transaction.findOne({ where: { id: tid, ...visibleTransactionWhere(req) } });
    if (!txn) {
      res.status(404).json({ error: 'Transaction not found' });
      return;
    }
    const receipts = await Receipt.findAll({
      where: { transactionId: tid },
      order: [['createdAt', 'DESC']],
    });
    const orderIds = receipts.map((r) => r.externalOrderId).filter((x): x is number => x != null);
    const [orders, items] = await Promise.all([
      orderIds.length
        ? ExternalOrder.findAll({ where: { id: { [Op.in]: orderIds } } })
        : Promise.resolve([]),
      orderIds.length
        ? ExternalOrderItem.findAll({ where: { externalOrderId: { [Op.in]: orderIds } } })
        : Promise.resolve([]),
    ]);
    const ordersById = new Map(orders.map((o) => [o.id, o]));
    const itemsByOrder = new Map<number, typeof items>();
    for (const it of items) {
      const list = itemsByOrder.get(it.externalOrderId) ?? [];
      list.push(it);
      itemsByOrder.set(it.externalOrderId, list);
    }
    res.json(
      receipts.map((r) => {
        const order = r.externalOrderId != null ? ordersById.get(r.externalOrderId) : null;
        return {
          id: r.id,
          transactionId: r.transactionId,
          originalName: r.originalName,
          mimeType: r.mimeType,
          sizeBytes: r.sizeBytes,
          extractedNote: r.extractedNote,
          createdAt: r.createdAt,
          externalOrderId: r.externalOrderId,
          order: order
            ? {
                id: order.id,
                vendor: order.vendor,
                subtotal: order.subtotal,
                tax: order.tax,
                shipping: order.shipping,
                total: order.total,
                currency: order.currency,
              }
            : null,
          items: (r.externalOrderId != null ? (itemsByOrder.get(r.externalOrderId) ?? []) : []).map(
            (it) => ({
              id: it.id,
              externalOrderId: it.externalOrderId,
              title: it.title,
              quantity: it.quantity,
              unitPrice: it.unitPrice,
              totalPrice: it.totalPrice,
              inferredCategory: it.inferredCategory,
              categoryOverride: it.categoryOverride,
              businessUsePercent: it.businessUsePercent,
              businessUseOverride: it.businessUseOverride,
            }),
          ),
        };
      }),
    );
  } catch (e) {
    next(e);
  }
});
```

Ensure `ExternalOrder`, `ExternalOrderItem`, `Op` are imported at the top.

- [ ] **Step 3: Write integration test**

Create `backend/test/integration/transactionReceiptsWithItems.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { setupTestApp, type TestApp } from '../helpers/setupTestApp';
import { ExternalOrder, ExternalOrderItem, Receipt } from '../../src/models';
import { writeReceiptObject } from '../../src/storage/receiptStorage';

describe('GET /api/transactions/:tid/receipts with items', () => {
  let app: TestApp;
  beforeEach(async () => {
    app = await setupTestApp();
  });

  it('returns empty items[] for receipts without externalOrderId', async () => {
    const txn = await app.factories.createTxn({ amount: '-10.00', date: '2026-05-20' });
    const stored = await writeReceiptObject(Buffer.from('x'), 'image/png');
    await Receipt.create({
      transactionId: txn.id,
      storedFilename: stored,
      originalName: 'r.png',
      mimeType: 'image/png',
      sizeBytes: 1,
      extractedNote: null,
    } as never);
    const res = await app.agent.get(`/api/transactions/${txn.id}/receipts`);
    expect(res.status).toBe(200);
    expect(res.body[0].items).toEqual([]);
    expect(res.body[0].order).toBeNull();
  });

  it('returns items[] when receipt has externalOrderId', async () => {
    const txn = await app.factories.createTxn({ amount: '-50.00', date: '2026-05-20' });
    const order = await ExternalOrder.create({
      vendor: 'costco',
      dedupeKey: 'k1',
      total: '50.00',
      currency: 'CAD',
      source: 'test',
    } as never);
    await ExternalOrderItem.create({
      externalOrderId: order.id,
      title: 'Milk',
      quantity: 1,
      totalPrice: '50.00',
      inferredCategory: 'Groceries',
    } as never);
    const stored = await writeReceiptObject(Buffer.from('x'), 'image/png');
    await Receipt.create({
      transactionId: txn.id,
      storedFilename: stored,
      originalName: 'r.png',
      mimeType: 'image/png',
      sizeBytes: 1,
      extractedNote: null,
      externalOrderId: order.id,
    } as never);
    const res = await app.agent.get(`/api/transactions/${txn.id}/receipts`);
    expect(res.status).toBe(200);
    expect(res.body[0].items).toHaveLength(1);
    expect(res.body[0].items[0].title).toBe('Milk');
    expect(res.body[0].order?.total).toBe('50.0000');
  });
});
```

Run: `yarn workspace backend test -- backend/test/integration/transactionReceiptsWithItems.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add backend/src/routes/receipts.ts shared/api-types.ts backend/test/integration/transactionReceiptsWithItems.test.ts
git commit -m "feat(receipts): GET receipts includes order + items"
```

---

## Task 15: Dashboard rollup integration test

**Files:**
- Create: `backend/test/integration/dashboardWithItems.test.ts`

- [ ] **Step 1: Write test**

Create `backend/test/integration/dashboardWithItems.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { setupTestApp, type TestApp } from '../helpers/setupTestApp';
import {
  ExternalOrder,
  ExternalOrderItem,
  TransactionOrderLink,
} from '../../src/models';

describe('GET /api/summary/dashboard with item allocations', () => {
  let app: TestApp;
  beforeEach(async () => {
    app = await setupTestApp();
  });

  it('splits a txn across item categories with pro-rated tax', async () => {
    const txn = await app.factories.createTxn({
      amount: '-105.00',
      date: '2026-05-20',
      merchantRaw: 'COSTCO',
      merchantClean: 'COSTCO',
      finalCategory: 'Shopping',
      currency: 'CAD',
    });
    const order = await ExternalOrder.create({
      vendor: 'costco',
      dedupeKey: 'k1',
      subtotal: '100.00',
      tax: '5.00',
      total: '105.00',
      currency: 'CAD',
      source: 'test',
    } as never);
    await ExternalOrderItem.bulkCreate([
      {
        externalOrderId: order.id,
        title: 'Eggs',
        quantity: 1,
        totalPrice: '60.00',
        inferredCategory: 'Groceries',
      },
      {
        externalOrderId: order.id,
        title: 'Soap',
        quantity: 1,
        totalPrice: '40.00',
        categoryOverride: 'Household',
        inferredCategory: 'Cleaning',
      },
    ] as never[]);
    await TransactionOrderLink.create({
      transactionId: txn.id,
      externalOrderId: order.id,
      confidence: '95',
      matchReason: 'test',
      status: 'confirmed',
      linkedAmount: '105.00',
    } as never);

    const res = await app.agent.get('/api/summary/dashboard');
    expect(res.status).toBe(200);
    const cats: Array<{ category: string | null; totalSpend: number }> =
      res.body.categoryReports;
    const groceries = cats.find((c) => c.category === 'Groceries');
    const household = cats.find((c) => c.category === 'Household');
    // Item shares: 60 + (60/100)*5 = 63, 40 + (40/100)*5 = 42
    expect(groceries?.totalSpend).toBeCloseTo(63, 1);
    expect(household?.totalSpend).toBeCloseTo(42, 1);
  });

  it('falls back to txn category when no items linked', async () => {
    const txn = await app.factories.createTxn({
      amount: '-50.00',
      date: '2026-05-20',
      finalCategory: 'Dining',
      currency: 'CAD',
    });
    const res = await app.agent.get('/api/summary/dashboard');
    const cats: Array<{ category: string | null; totalSpend: number }> =
      res.body.categoryReports;
    const dining = cats.find((c) => c.category === 'Dining');
    expect(dining?.totalSpend).toBeCloseTo(50, 1);
  });
});
```

Run: `yarn workspace backend test -- backend/test/integration/dashboardWithItems.test.ts`
Expected: PASS.

- [ ] **Step 2: Commit**

```bash
git add backend/test/integration/dashboardWithItems.test.ts
git commit -m "test(summary): cover dashboard rollup with item allocations"
```

---

## Task 16: Frontend — ReceiptItemsDrawer component

**Files:**
- Create: `frontend/src/components/ReceiptItemsDrawer.tsx`
- Create: `frontend/src/components/ReceiptItemsDrawer.test.tsx`

- [ ] **Step 1: Write failing test**

Create `frontend/src/components/ReceiptItemsDrawer.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import ReceiptItemsDrawer from './ReceiptItemsDrawer';
import type { ReceiptWithItems } from '../../../shared/api-types';

beforeEach(() => {
  global.fetch = vi.fn();
});

const sampleReceipt: ReceiptWithItems = {
  id: 1,
  transactionId: 10,
  originalName: 'r.png',
  mimeType: 'image/png',
  sizeBytes: 100,
  extractedNote: null,
  createdAt: '2026-05-20T00:00:00Z',
  externalOrderId: 5,
  order: {
    id: 5,
    vendor: 'costco',
    subtotal: '90.00',
    tax: '10.00',
    shipping: null,
    total: '100.00',
    currency: 'CAD',
  },
  items: [
    {
      id: 1,
      externalOrderId: 5,
      title: 'Eggs',
      quantity: 1,
      unitPrice: null,
      totalPrice: '60.00',
      inferredCategory: 'Groceries',
      categoryOverride: null,
      businessUsePercent: null,
      businessUseOverride: null,
    },
    {
      id: 2,
      externalOrderId: 5,
      title: 'Soap',
      quantity: 1,
      unitPrice: null,
      totalPrice: '30.00',
      inferredCategory: 'Household',
      categoryOverride: null,
      businessUsePercent: null,
      businessUseOverride: null,
    },
  ],
};

describe('ReceiptItemsDrawer', () => {
  it('renders items + totals when receipt has order', () => {
    render(
      <ReceiptItemsDrawer
        open
        onClose={() => {}}
        receipts={[sampleReceipt]}
        categoryHints={['Groceries', 'Household']}
        onExtract={async () => {}}
      />,
    );
    expect(screen.getByText('Eggs')).toBeInTheDocument();
    expect(screen.getByText('Soap')).toBeInTheDocument();
    expect(screen.getByText(/Subtotal/i)).toBeInTheDocument();
    expect(screen.getByText(/Tax/i)).toBeInTheDocument();
    expect(screen.getByText(/Total/i)).toBeInTheDocument();
  });

  it('shows Extract items button when receipt has no externalOrderId', () => {
    const onExtract = vi.fn(async () => {});
    const r: ReceiptWithItems = { ...sampleReceipt, externalOrderId: null, order: null, items: [] };
    render(
      <ReceiptItemsDrawer
        open
        onClose={() => {}}
        receipts={[r]}
        categoryHints={[]}
        onExtract={onExtract}
      />,
    );
    const btn = screen.getByRole('button', { name: /extract items/i });
    fireEvent.click(btn);
    expect(onExtract).toHaveBeenCalledWith(r.id);
  });

  it('PATCHes when category override changes', async () => {
    const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ id: 1, categoryOverride: 'Snacks' }),
    } as Response);
    render(
      <ReceiptItemsDrawer
        open
        onClose={() => {}}
        receipts={[sampleReceipt]}
        categoryHints={['Groceries', 'Household', 'Snacks']}
        onExtract={async () => {}}
      />,
    );
    const select = screen.getAllByRole('combobox')[0];
    fireEvent.change(select, { target: { value: 'Snacks' } });
    fireEvent.blur(select);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('/api/external-order-items/1');
    expect((init as RequestInit).method).toBe('PATCH');
  });
});
```

Run: `yarn workspace frontend test -- ReceiptItemsDrawer`
Expected: FAIL — component not found.

- [ ] **Step 2: Implement component**

Create `frontend/src/components/ReceiptItemsDrawer.tsx`:

```tsx
import { useState } from 'react';
import type { ReceiptWithItems, ExternalOrderItemView } from '../../../shared/api-types';

export type Props = {
  open: boolean;
  onClose: () => void;
  receipts: ReceiptWithItems[];
  categoryHints: string[];
  onExtract: (receiptId: number) => Promise<void>;
};

function fmt(n: string | null, currency: string): string {
  if (n == null) return '—';
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency,
  }).format(Number(n));
}

export default function ReceiptItemsDrawer({
  open,
  onClose,
  receipts,
  categoryHints,
  onExtract,
}: Props) {
  if (!open) return null;
  return (
    <div className="receiptItemsDrawer" role="dialog" aria-label="Receipt items">
      <header>
        <button type="button" onClick={onClose} aria-label="Close">×</button>
        <h2>Receipt items</h2>
      </header>
      {receipts.map((r) => (
        <ReceiptPanel
          key={r.id}
          receipt={r}
          categoryHints={categoryHints}
          onExtract={onExtract}
        />
      ))}
    </div>
  );
}

function ReceiptPanel({
  receipt,
  categoryHints,
  onExtract,
}: {
  receipt: ReceiptWithItems;
  categoryHints: string[];
  onExtract: (receiptId: number) => Promise<void>;
}) {
  const [extracting, setExtracting] = useState(false);
  const [extractError, setExtractError] = useState<string | null>(null);

  if (receipt.externalOrderId == null) {
    return (
      <section className="receiptPanel">
        <h3>{receipt.originalName}</h3>
        <p>No items extracted yet.</p>
        <button
          type="button"
          disabled={extracting}
          onClick={async () => {
            setExtracting(true);
            setExtractError(null);
            try {
              await onExtract(receipt.id);
            } catch (e) {
              setExtractError(e instanceof Error ? e.message : 'Extraction failed');
            } finally {
              setExtracting(false);
            }
          }}
        >
          {extracting ? 'Extracting…' : 'Extract items'}
        </button>
        {extractError && <p role="alert">{extractError}</p>}
      </section>
    );
  }

  const currency = receipt.order?.currency ?? 'USD';
  return (
    <section className="receiptPanel">
      <h3>
        {receipt.order?.vendor ?? 'Receipt'} — {receipt.originalName}
      </h3>
      <table>
        <thead>
          <tr>
            <th>Item</th>
            <th>Qty</th>
            <th>Total</th>
            <th>Category</th>
            <th>Business %</th>
          </tr>
        </thead>
        <tbody>
          {receipt.items.map((item) => (
            <ItemRow
              key={item.id}
              item={item}
              categoryHints={categoryHints}
              currency={currency}
            />
          ))}
        </tbody>
        <tfoot>
          <tr><td colSpan={2}>Subtotal</td><td>{fmt(receipt.order?.subtotal ?? null, currency)}</td><td colSpan={2}></td></tr>
          <tr><td colSpan={2}>Tax</td><td>{fmt(receipt.order?.tax ?? null, currency)}</td><td colSpan={2}></td></tr>
          {receipt.order?.shipping != null && (
            <tr><td colSpan={2}>Shipping</td><td>{fmt(receipt.order.shipping, currency)}</td><td colSpan={2}></td></tr>
          )}
          <tr><td colSpan={2}><strong>Total</strong></td><td><strong>{fmt(receipt.order?.total ?? null, currency)}</strong></td><td colSpan={2}></td></tr>
        </tfoot>
      </table>
    </section>
  );
}

function ItemRow({
  item,
  categoryHints,
  currency,
}: {
  item: ExternalOrderItemView;
  categoryHints: string[];
  currency: string;
}) {
  const [category, setCategory] = useState<string>(
    item.categoryOverride ?? item.inferredCategory ?? '',
  );
  const [businessPct, setBusinessPct] = useState<string>(
    item.businessUseOverride ?? item.businessUsePercent ?? '',
  );

  async function patch(body: Record<string, unknown>) {
    const res = await fetch(`/api/external-order-items/${item.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`PATCH failed: ${res.status}`);
  }

  return (
    <tr>
      <td>{item.title}</td>
      <td>{item.quantity}</td>
      <td>{fmt(item.totalPrice, currency)}</td>
      <td>
        <select
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          onBlur={() => {
            const next = category === '' ? null : category;
            if (next !== (item.categoryOverride ?? item.inferredCategory ?? null)) {
              void patch({ categoryOverride: next });
            }
          }}
        >
          <option value="">(uncategorized)</option>
          {categoryHints.map((c) => (
            <option key={c} value={c}>{c}</option>
          ))}
        </select>
      </td>
      <td>
        <input
          type="number"
          min={0}
          max={100}
          value={businessPct}
          onChange={(e) => setBusinessPct(e.target.value)}
          onBlur={() => {
            const next = businessPct === '' ? null : Number(businessPct);
            if (next !== (item.businessUseOverride != null ? Number(item.businessUseOverride) : null)) {
              void patch({ businessUseOverride: next });
            }
          }}
        />
      </td>
    </tr>
  );
}
```

- [ ] **Step 3: Run drawer tests**

Run: `yarn workspace frontend test -- ReceiptItemsDrawer`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/ReceiptItemsDrawer.tsx frontend/src/components/ReceiptItemsDrawer.test.tsx
git commit -m "feat(frontend): ReceiptItemsDrawer with category + business overrides"
```

---

## Task 17: Wire drawer into TransactionsPage

**Files:**
- Modify: `frontend/src/pages/TransactionsPage.tsx`

- [ ] **Step 1: Add drawer state + fetch**

Open `frontend/src/pages/TransactionsPage.tsx`. At the top imports, add:

```tsx
import ReceiptItemsDrawer from '../components/ReceiptItemsDrawer';
import type { ReceiptWithItems } from '../../../shared/api-types';
```

Inside the page component (alongside other `useState` calls), add:

```tsx
const [itemsDrawer, setItemsDrawer] = useState<{ txnId: number; receipts: ReceiptWithItems[] } | null>(null);

async function openItemsDrawer(txnId: number) {
  const receipts = await getJson<ReceiptWithItems[]>(`/api/transactions/${txnId}/receipts`);
  setItemsDrawer({ txnId, receipts });
}

async function reloadItemsDrawer() {
  if (!itemsDrawer) return;
  const receipts = await getJson<ReceiptWithItems[]>(
    `/api/transactions/${itemsDrawer.txnId}/receipts`,
  );
  setItemsDrawer({ txnId: itemsDrawer.txnId, receipts });
}

async function onExtractReceipt(receiptId: number) {
  await postJson(`/api/receipts/${receiptId}/analyze`, {});
  await reloadItemsDrawer();
}
```

- [ ] **Step 2: Add the "View items" button on rows with receipts**

Find the existing `txnReceiptAction` button (around line 1695). Right after it, add:

```tsx
{(t.receiptCount ?? 0) > 0 && (
  <button
    type="button"
    className="txnReceiptAction"
    onClick={() => void openItemsDrawer(t.id)}
    title="View receipt items"
  >
    View items
  </button>
)}
```

- [ ] **Step 3: Render the drawer at page level**

Near the existing dialogs at the bottom of the JSX return, add:

```tsx
<ReceiptItemsDrawer
  open={itemsDrawer != null}
  onClose={() => setItemsDrawer(null)}
  receipts={itemsDrawer?.receipts ?? []}
  categoryHints={categoryHints.map((c) => c.label)}
  onExtract={onExtractReceipt}
/>
```

(`categoryHints` is already loaded earlier in this file at line ~237.)

- [ ] **Step 4: Typecheck + run page tests**

Run: `yarn workspace frontend tsc --noEmit`
Expected: PASS.

Run: `yarn workspace frontend test -- TransactionsPage`
Expected: PASS (existing tests, plus the new button doesn't break them).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/pages/TransactionsPage.tsx
git commit -m "feat(frontend): wire View items button into TransactionsPage"
```

---

## Task 18: Manual verification

**Files:**
- No code changes.

- [ ] **Step 1: Start backend + frontend dev servers**

Run: `yarn workspace backend dev` (background)
Run: `yarn workspace frontend dev` (background)

Wait for both to report ready.

- [ ] **Step 2: Verify existing flows unbroken**

In a browser:
1. Open Transactions page. Confirm the page loads (no console errors).
2. Open `/api/summary/dashboard` directly. Confirm response has `categoryReports`.
3. If a Costco-till PDF test fixture is available, run the PDF import flow once and confirm an ExternalOrder appears.

- [ ] **Step 3: Verify new flow**

1. Attach a real receipt image to any txn via the existing "Attach receipt" button.
2. Click the new "View items" button on that txn row.
3. Confirm the drawer opens with the receipt panel showing "Extract items" button.
4. Click "Extract items". Wait for OpenAI response. Confirm the panel re-renders with items.
5. Change one item's category in the dropdown, click outside the dropdown.
6. Reload the page. Re-open the drawer. Confirm the override persisted.
7. Open the dashboard. Confirm the new category appears in `categoryReports` with the prorated amount.

- [ ] **Step 4: Stop dev servers**

Stop both background processes.

- [ ] **Step 5: No commit** — manual verification only.

---

## Self-Review

Run through the spec once each task is mapped:

1. **Spec coverage:** Migration (Task 1) → Models (Tasks 2-4) → Allocator (Tasks 5-7) → Aggregators (Tasks 8-9) → Vision pipeline switch (Tasks 10-11) → PATCH route (Tasks 12-13) → GET extension (Task 14) → Rollup test (Task 15) → Frontend (Tasks 16-17) → Manual verification (Task 18). Every spec section is mapped.

2. **Placeholder scan:** No `TBD`, no "add error handling" without code. All test stubs have real expectations.

3. **Type consistency:** `AllocatorInput` / `CategoryAllocation` defined in Task 6, consumed in Tasks 7-9. `ReceiptWithItems` / `ExternalOrderItemView` defined in Task 14, consumed in Tasks 16-17.

4. **Ambiguity check:** Helper-factory shapes (`setupTestApp`, `createTxn`) noted as adapt-to-existing in Tasks 11/13. Migration field order in models matches DB column order. PATCH body parsing handles `null` to clear overrides explicitly.

Plan ready to hand to subagent-driven-development.
