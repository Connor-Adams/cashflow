# Item-Review Mechanic Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A transaction linked to an itemized receipt drops out of the review queue when every item is high-confidence AI (`confidence >= 80`) or user-overridden; the review inbox surfaces the un-categorized stragglers inline for fix-in-place.

**Architecture:** A pure predicate (`transactionClearsFromItems`) plus a best-effort DB recompute (`recomputeTransactionReviewFromItems`) that OR's an item-clear onto the existing review baseline. The baseline is re-derived statelessly from persisted `TransactionSignal` rows via `mergeSignals`, so `reviewFlag` stays the single authoritative column and override-removal correctly re-flags. Recompute is called at every item-state mutation site and by a backfill sweep over existing itemized transactions.

**Tech Stack:** TypeScript, Node `node:test` runner via `tsx`, Sequelize (SQLite/Postgres), Express, React/Vite.

**Spec:** `docs/superpowers/specs/2026-06-02-item-review-mechanic-design.md`

**Test runner note:** run a single backend test file with
`cd backend && npx tsx --import ./test/setup.ts --test test/<file>.test.ts`.

---

## File Structure

**New backend files:**
- `backend/src/import/enrichment/transactionClearsFromItems.ts` — pure predicate (`itemMeetsBar`, `transactionClearsFromItems`).
- `backend/src/import/enrichment/recomputeTransactionReviewFromItems.ts` — best-effort DB recompute + writeback.
- `backend/test/transactionClearsFromItems.test.ts` — unit tests for the predicate.
- `backend/test/recomputeTransactionReviewFromItems.test.ts` — integration tests for recompute + triggers + backfill.

**Modified backend files:**
- `backend/src/config/env.ts` — `enrichmentItemClearConfidence` env knob.
- `backend/src/import/categorizeReceiptItems.ts` — recompute after Costco batch.
- `backend/src/routes/externalOrders.ts` — recompute after Amazon `/categorize-items`.
- `backend/src/routes/receipts.ts` — recompute after item override PATCH + `/receipts/:id/analyze`.
- `backend/src/routes/items.ts` — recompute after item bulk-patch.
- `backend/src/import/matchReceiptToTransactions.ts` + link-status route — recompute on link/unlink.
- `backend/src/routes/transactions.ts` — `itemized` summary in the list payload.
- `backend/src/import/enrichmentBackfillScheduler.ts` — recompute sweep folded into the nightly tick.

**Modified frontend files:**
- `frontend/src/types/api.ts` — `itemized` field on the transaction list row.
- `frontend/src/pages/ReviewInboxPage.tsx` — badge + expand-in-row using the existing `ItemRow`.

---

## Task 1: Env knob for the per-item confidence threshold

**Files:**
- Modify: `backend/src/config/env.ts` (near the `enrichmentAi*` exports, lines ~402-413)
- Test: `backend/test/config/enrichmentItemClearConfidence.test.ts` (create)

- [ ] **Step 1: Write the failing test**

```ts
// backend/test/config/enrichmentItemClearConfidence.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('enrichmentItemClearConfidence defaults to 80 when env unset', async () => {
  delete process.env.ENRICHMENT_ITEM_CLEAR_CONFIDENCE;
  const mod = await import('../../src/config/env.ts?case=default');
  assert.equal(mod.enrichmentItemClearConfidence, 80);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx tsx --import ./test/setup.ts --test test/config/enrichmentItemClearConfidence.test.ts`
Expected: FAIL — `enrichmentItemClearConfidence` is `undefined`.

- [ ] **Step 3: Add the export**

In `backend/src/config/env.ts`, directly after the `enrichmentAiPerRowConcurrency` export (~line 413):

```ts
/** Per-item confidence (0-100) at/above which an AI-inferred item category is
 *  trusted enough to count toward auto-clearing a transaction's review flag. */
export const enrichmentItemClearConfidence = parseIntEnv(
  'ENRICHMENT_ITEM_CLEAR_CONFIDENCE',
  80,
);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && npx tsx --import ./test/setup.ts --test test/config/enrichmentItemClearConfidence.test.ts`
Expected: PASS. (If the `?case=default` import suffix is unsupported in this setup, replace with a plain `await import('../../src/config/env.ts')` — the env var is deleted before import so the default applies.)

- [ ] **Step 5: Commit**

```bash
git add backend/src/config/env.ts backend/test/config/enrichmentItemClearConfidence.test.ts
git commit --no-verify -m "feat(enrichment): add ENRICHMENT_ITEM_CLEAR_CONFIDENCE env knob (default 80)"
```

> Note: this repo's pre-commit hook (`lint-staged`) is not installed in the worktree and exits 127. Use `--no-verify` on commits in this plan; run lint/typecheck explicitly in the verification task.

---

## Task 2: Pure predicate `transactionClearsFromItems`

**Files:**
- Create: `backend/src/import/enrichment/transactionClearsFromItems.ts`
- Test: `backend/test/transactionClearsFromItems.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// backend/test/transactionClearsFromItems.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  itemMeetsBar,
  transactionClearsFromItems,
  type ItemClearInput,
} from '../src/import/enrichment/transactionClearsFromItems';

const T = 80;
function item(p: Partial<ItemClearInput>): ItemClearInput {
  return { inferredCategory: null, categoryOverride: null, confidence: null, ...p };
}

test('high-confidence AI item meets the bar', () => {
  assert.equal(itemMeetsBar(item({ inferredCategory: 'Groceries', confidence: 95 }), T), true);
});

test('low-confidence AI item fails the bar', () => {
  assert.equal(itemMeetsBar(item({ inferredCategory: 'Groceries', confidence: 40 }), T), false);
});

test('confidence exactly at threshold meets the bar', () => {
  assert.equal(itemMeetsBar(item({ inferredCategory: 'X', confidence: 80 }), T), true);
});

test('null confidence fails the bar even with a category', () => {
  assert.equal(itemMeetsBar(item({ inferredCategory: 'X', confidence: null }), T), false);
});

test('user override counts regardless of confidence', () => {
  assert.equal(itemMeetsBar(item({ categoryOverride: 'Household', confidence: 10 }), T), true);
});

test('all items high-confidence => transaction clears', () => {
  const items = [
    item({ inferredCategory: 'A', confidence: 90 }),
    item({ categoryOverride: 'B' }),
  ];
  assert.equal(transactionClearsFromItems(items, T), true);
});

test('one straggler => transaction does not clear', () => {
  const items = [
    item({ inferredCategory: 'A', confidence: 90 }),
    item({ inferredCategory: 'B', confidence: 30 }),
  ];
  assert.equal(transactionClearsFromItems(items, T), false);
});

test('zero items => does not clear (fall back to normal logic)', () => {
  assert.equal(transactionClearsFromItems([], T), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx tsx --import ./test/setup.ts --test test/transactionClearsFromItems.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the predicate**

```ts
// backend/src/import/enrichment/transactionClearsFromItems.ts

/** Minimal shape needed to decide whether one receipt item is "done". */
export type ItemClearInput = {
  inferredCategory: string | null;
  categoryOverride: string | null;
  /** AI confidence on the 0-100 scale; null when uncategorized. */
  confidence: number | null;
};

/**
 * An item counts as done when the user has overridden its category, or when AI
 * inferred a category at/above the trust threshold. A null/low confidence
 * AI guess is a "straggler" that keeps the parent transaction in review.
 */
export function itemMeetsBar(item: ItemClearInput, threshold: number): boolean {
  if (item.categoryOverride != null && item.categoryOverride !== '') return true;
  return (
    item.inferredCategory != null &&
    item.inferredCategory !== '' &&
    item.confidence != null &&
    item.confidence >= threshold
  );
}

/**
 * A transaction clears review from its items only when it HAS items and EVERY
 * item meets the bar. Zero items => false, so callers fall back to the normal
 * (signal-based) review logic.
 */
export function transactionClearsFromItems(items: ItemClearInput[], threshold: number): boolean {
  if (items.length === 0) return false;
  return items.every((i) => itemMeetsBar(i, threshold));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && npx tsx --import ./test/setup.ts --test test/transactionClearsFromItems.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add backend/src/import/enrichment/transactionClearsFromItems.ts backend/test/transactionClearsFromItems.test.ts
git commit --no-verify -m "feat(enrichment): pure transactionClearsFromItems predicate"
```

---

## Task 3: `recomputeTransactionReviewFromItems(txnId)`

Loads a transaction, its persisted signals, its accepted linked orders and their
items; recomputes the review baseline via `mergeSignals`, OR's the item-clear,
and writes back `reviewFlag` + `importConfidence` + `importConfidenceFlags`.
Best-effort: any error is logged and the row is left untouched.

**Files:**
- Create: `backend/src/import/enrichment/recomputeTransactionReviewFromItems.ts`
- Test: `backend/test/recomputeTransactionReviewFromItems.test.ts`

Key facts (verified):
- Associations: `Transaction.hasMany(TransactionOrderLink, { as: 'orderLinks' })`, `TransactionOrderLink.belongsTo(ExternalOrder, { as: 'order' })`, `ExternalOrder.hasMany(ExternalOrderItem, { as: 'items' })`, `Transaction.hasMany(TransactionSignal, { as: 'enrichmentSignals' })`, `Transaction.belongsTo(Account, { as: 'account' })`.
- `TransactionOrderLink.status` ∈ `'suggested' | 'accepted' | 'rejected'` — only `'accepted'` counts.
- `mergeSignals(signals: Signal[])` returns `{ fields: { reviewFlag, ... }, signals }` (`computeReviewFlag.ts`).
- `computeImportConfidence(input): { state, flags }` (`computeImportConfidence.ts`), `serializeFlags(flags)` (`computeImportConfidence.ts`).
- `Account.visibility` is `'private' | 'shared'`.

- [ ] **Step 1: Write the failing integration test**

```ts
// backend/test/recomputeTransactionReviewFromItems.test.ts
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { sequelize, Account, Transaction, TransactionSignal,
  ExternalOrder, ExternalOrderItem, TransactionOrderLink, Household } from '../src/models';
import { recomputeTransactionReviewFromItems } from '../src/import/enrichment/recomputeTransactionReviewFromItems';

let householdId: number;
let accountId: number;

before(async () => {
  await sequelize.sync({ force: true });
  const hh = await Household.create({ name: 'H' } as never);
  householdId = hh.id;
  const acct = await Account.create({
    householdId, name: 'Card', type: 'credit', currency: 'CAD', visibility: 'private',
  } as never);
  accountId = acct.id;
});

async function makeItemizedTxn(opts: {
  reviewFlag: boolean;
  signals: Array<{ source: string; confidence: string; fields: Record<string, unknown> }>;
  items: Array<{ inferredCategory: string | null; categoryOverride: string | null; confidence: number | null }>;
}): Promise<number> {
  const txn = await Transaction.create({
    accountId, date: '2026-05-01', amount: '-100.00', merchantRaw: 'COSTCO',
    txnType: 'purchase', reviewFlag: opts.reviewFlag, finalSplitType: 'me',
  } as never);
  for (const s of opts.signals) {
    await TransactionSignal.create({ transactionId: txn.id, source: s.source, confidence: s.confidence, fields: s.fields });
  }
  const order = await ExternalOrder.create({
    householdId, vendor: 'costco', total: '100.00', currency: 'CAD', orderDate: '2026-05-01',
  } as never);
  for (const it of opts.items) {
    await ExternalOrderItem.create({
      externalOrderId: order.id, title: 'x', inferredCategory: it.inferredCategory,
      categoryOverride: it.categoryOverride, confidence: it.confidence,
    } as never);
  }
  await TransactionOrderLink.create({
    transactionId: txn.id, externalOrderId: order.id, status: 'accepted',
  } as never);
  return txn.id;
}

test('all items high-confidence -> reviewFlag cleared', async () => {
  const id = await makeItemizedTxn({
    reviewFlag: true,
    signals: [{ source: 'item-link', confidence: 'medium', fields: { autoCategory: 'Mixed' } }],
    items: [
      { inferredCategory: 'Groceries', categoryOverride: null, confidence: 95 },
      { inferredCategory: 'Household', categoryOverride: null, confidence: 88 },
    ],
  });
  await recomputeTransactionReviewFromItems(id);
  const txn = await Transaction.findByPk(id);
  assert.equal(txn!.reviewFlag, false);
  assert.equal(txn!.importConfidence, 'clean');
});

test('one straggler -> stays in review', async () => {
  const id = await makeItemizedTxn({
    reviewFlag: true,
    signals: [{ source: 'item-link', confidence: 'medium', fields: { autoCategory: 'Mixed' } }],
    items: [
      { inferredCategory: 'Groceries', categoryOverride: null, confidence: 95 },
      { inferredCategory: 'Household', categoryOverride: null, confidence: 30 },
    ],
  });
  await recomputeTransactionReviewFromItems(id);
  const txn = await Transaction.findByPk(id);
  assert.equal(txn!.reviewFlag, true);
});

test('rule-high baseline stays cleared even with straggler items', async () => {
  const id = await makeItemizedTxn({
    reviewFlag: false,
    signals: [{ source: 'rule', confidence: 'high', fields: { autoCategory: 'Groceries' } }],
    items: [{ inferredCategory: 'Household', categoryOverride: null, confidence: 30 }],
  });
  await recomputeTransactionReviewFromItems(id);
  const txn = await Transaction.findByPk(id);
  assert.equal(txn!.reviewFlag, false); // baseline already cleared; item-clear only adds, never re-flags below baseline
});

test('removing the override that cleared an item re-flags the transaction', async () => {
  const id = await makeItemizedTxn({
    reviewFlag: true,
    signals: [{ source: 'item-link', confidence: 'medium', fields: { autoCategory: 'Mixed' } }],
    items: [{ inferredCategory: null, categoryOverride: 'Household', confidence: null }],
  });
  await recomputeTransactionReviewFromItems(id);
  assert.equal((await Transaction.findByPk(id))!.reviewFlag, false);
  // user clears the override
  await ExternalOrderItem.update({ categoryOverride: null }, { where: {} });
  await recomputeTransactionReviewFromItems(id);
  assert.equal((await Transaction.findByPk(id))!.reviewFlag, true);
});

test('best-effort: unknown txn id does not throw', async () => {
  await recomputeTransactionReviewFromItems(999999);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx tsx --import ./test/setup.ts --test test/recomputeTransactionReviewFromItems.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement recompute**

```ts
// backend/src/import/enrichment/recomputeTransactionReviewFromItems.ts
import { logger } from '../../observability/logger';
import {
  Transaction, TransactionSignal, TransactionOrderLink, ExternalOrder, ExternalOrderItem, Account,
} from '../../models';
import { mergeSignals } from './computeReviewFlag';
import { transactionClearsFromItems, type ItemClearInput } from './transactionClearsFromItems';
import { computeImportConfidence, serializeFlags } from '../computeImportConfidence';
import { enrichmentItemClearConfidence } from '../../config/env';
import type { Signal } from './types';

function toNumber(v: unknown): number | null {
  if (v == null) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Recompute a transaction's review state from its receipt items, OR'd onto the
 * signal-based baseline. Best-effort: errors are logged, the row is untouched.
 */
export async function recomputeTransactionReviewFromItems(txnId: number): Promise<void> {
  try {
    const txn = await Transaction.findByPk(txnId, {
      include: [
        { model: TransactionSignal, as: 'enrichmentSignals' },
        { model: Account, as: 'account' },
        {
          model: TransactionOrderLink, as: 'orderLinks',
          include: [{ model: ExternalOrder, as: 'order', include: [{ model: ExternalOrderItem, as: 'items' }] }],
        },
      ],
    });
    if (txn == null) return;

    // Baseline review state from persisted signals (NOT from the column we overwrite).
    const signals: Signal[] = ((txn as unknown as { enrichmentSignals?: Array<{ source: string; confidence: string; fields: Record<string, unknown>; rationale?: string | null }> }).enrichmentSignals ?? [])
      .map((s) => ({ source: s.source as Signal['source'], confidence: s.confidence as Signal['confidence'], fields: s.fields as Signal['fields'], ...(s.rationale ? { rationale: s.rationale } : {}) }));
    const baselineReviewFlag = signals.length > 0 ? mergeSignals(signals).fields.reviewFlag : txn.reviewFlag;

    // Items across accepted links only.
    const links = (txn as unknown as { orderLinks?: Array<{ status: string; order?: { items?: Array<{ inferredCategory: string | null; categoryOverride: string | null; confidence: unknown }> } }> }).orderLinks ?? [];
    const items: ItemClearInput[] = links
      .filter((l) => l.status === 'accepted')
      .flatMap((l) => l.order?.items ?? [])
      .map((i) => ({ inferredCategory: i.inferredCategory, categoryOverride: i.categoryOverride, confidence: toNumber(i.confidence) }));

    const itemClear = transactionClearsFromItems(items, enrichmentItemClearConfidence);
    const reviewFlag = baselineReviewFlag && !itemClear;

    const visibility = ((txn as unknown as { account?: { visibility?: string } }).account?.visibility === 'shared') ? 'shared' : 'private';
    const confidence = computeImportConfidence({
      reviewFlag,
      finalCategory: txn.finalCategory,
      autoCategory: txn.autoCategory,
      autoSplitType: txn.autoSplitType,
      finalSplitType: txn.finalSplitType ?? 'me',
      txnType: txn.txnType ?? 'purchase',
      accountVisibility: visibility,
      linkedTransactionId: txn.linkedTransactionId,
      amount: txn.amount,
    });

    await Transaction.update(
      { reviewFlag, importConfidence: confidence.state, importConfidenceFlags: serializeFlags(confidence.flags) },
      { where: { id: txnId } },
    );
  } catch (err) {
    logger.warn({ err, txnId, module: 'enrichment' }, 'recompute_review_from_items_failed');
  }
}

/** Recompute many transactions, deduped. Used by mutation sites and backfill. */
export async function recomputeTransactionsReviewFromItems(txnIds: Iterable<number>): Promise<void> {
  const unique = [...new Set(txnIds)];
  for (const id of unique) {
    await recomputeTransactionReviewFromItems(id);
  }
}

/** Resolve the accepted-linked transaction ids for an order (for order-side triggers). */
export async function transactionIdsForOrder(orderId: number): Promise<number[]> {
  const links = await TransactionOrderLink.findAll({
    where: { externalOrderId: orderId, status: 'accepted' },
    attributes: ['transactionId'],
  });
  return links.map((l) => (l as unknown as { transactionId: number }).transactionId);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && npx tsx --import ./test/setup.ts --test test/recomputeTransactionReviewFromItems.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add backend/src/import/enrichment/recomputeTransactionReviewFromItems.ts backend/test/recomputeTransactionReviewFromItems.test.ts
git commit --no-verify -m "feat(enrichment): recomputeTransactionReviewFromItems (best-effort item-clear writeback)"
```

---

## Task 4: Trigger on item override (PATCH + bulk-patch)

**Files:**
- Modify: `backend/src/routes/receipts.ts` (the `PATCH /api/external-order-items/:id` handler, ~line 443)
- Modify: `backend/src/routes/items.ts` (the `POST /api/external-order-items/bulk-patch` handler, ~line 626)
- Test: append to `backend/test/recomputeTransactionReviewFromItems.test.ts`

- [ ] **Step 1: Write the failing test (append)**

```ts
import request from 'supertest';
import { app } from '../src/app'; // adjust if the Express app is exported elsewhere

test('PATCH item override clears the transaction via the route', async () => {
  // Build a txn with one straggler item linked through an accepted order.
  const txn = await Transaction.create({ accountId, date: '2026-05-02', amount: '-50.00', merchantRaw: 'COSTCO', txnType: 'purchase', reviewFlag: true, finalSplitType: 'me' } as never);
  await TransactionSignal.create({ transactionId: txn.id, source: 'item-link', confidence: 'medium', fields: { autoCategory: 'Mixed' } });
  const order = await ExternalOrder.create({ householdId, vendor: 'costco', total: '50.00', currency: 'CAD', orderDate: '2026-05-02' } as never);
  const item = await ExternalOrderItem.create({ externalOrderId: order.id, title: 'x', inferredCategory: null, categoryOverride: null, confidence: null } as never);
  await TransactionOrderLink.create({ transactionId: txn.id, externalOrderId: order.id, status: 'accepted' } as never);

  await request(app).patch(`/api/external-order-items/${item.id}`).send({ categoryOverride: 'Household' }).expect(200);

  assert.equal((await Transaction.findByPk(txn.id))!.reviewFlag, false);
});
```

> If the test setup has no authenticated-request helper, follow the auth pattern already used in `backend/test/*` route tests (search for `supertest` usages). If route-level testing is impractical here, assert by calling the handler's recompute directly and cover the wiring in the manual verification task.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx tsx --import ./test/setup.ts --test test/recomputeTransactionReviewFromItems.test.ts`
Expected: FAIL — `reviewFlag` still `true` (no recompute wired).

- [ ] **Step 3: Wire recompute into the PATCH handler**

In `backend/src/routes/receipts.ts`, locate the `PATCH /external-order-items/:id` handler. After the item update succeeds and before sending the response, add:

```ts
import { transactionIdsForOrder, recomputeTransactionsReviewFromItems } from '../import/enrichment/recomputeTransactionReviewFromItems';
// ...
// after the item override is persisted (item.externalOrderId is the parent order id):
const affected = await transactionIdsForOrder(item.externalOrderId);
await recomputeTransactionsReviewFromItems(affected);
```

In `backend/src/routes/items.ts`, in the `bulk-patch` handler, after all items are updated, collect their distinct order ids and recompute:

```ts
import { transactionIdsForOrder, recomputeTransactionsReviewFromItems } from '../import/enrichment/recomputeTransactionReviewFromItems';
// ...
const orderIds = [...new Set(updatedItems.map((i) => i.externalOrderId))];
const txnIds = (await Promise.all(orderIds.map(transactionIdsForOrder))).flat();
await recomputeTransactionsReviewFromItems(txnIds);
```

(Use the variable name that holds the patched items in that handler; if it returns only ids, re-query order ids via `ExternalOrderItem.findAll({ where: { id: itemIds }, attributes: ['externalOrderId'] })`.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && npx tsx --import ./test/setup.ts --test test/recomputeTransactionReviewFromItems.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/routes/receipts.ts backend/src/routes/items.ts backend/test/recomputeTransactionReviewFromItems.test.ts
git commit --no-verify -m "feat(enrichment): recompute review on item override (PATCH + bulk-patch)"
```

---

## Task 5: Trigger on categorization-complete, link/unlink, receipt analyze

**Files:**
- Modify: `backend/src/import/categorizeReceiptItems.ts` (after `categorizeAndApplyReceiptItems` persists categories)
- Modify: `backend/src/routes/externalOrders.ts` (Amazon `POST /:id/categorize-items`)
- Modify: `backend/src/import/matchReceiptToTransactions.ts` (after links are created/accepted) and the link reject/unlink route
- Modify: `backend/src/routes/receipts.ts` (`POST /receipts/:id/analyze`)
- Test: append to `backend/test/recomputeTransactionReviewFromItems.test.ts`

- [ ] **Step 1: Write the failing test (append)**

```ts
import { recomputeTransactionReviewFromItems } from '../src/import/enrichment/recomputeTransactionReviewFromItems';

test('categorization completing high-confidence clears an already-linked txn', async () => {
  const txn = await Transaction.create({ accountId, date: '2026-05-03', amount: '-20.00', merchantRaw: 'COSTCO', txnType: 'purchase', reviewFlag: true, finalSplitType: 'me' } as never);
  await TransactionSignal.create({ transactionId: txn.id, source: 'item-link', confidence: 'medium', fields: { autoCategory: 'Mixed' } });
  const order = await ExternalOrder.create({ householdId, vendor: 'costco', total: '20.00', currency: 'CAD', orderDate: '2026-05-03' } as never);
  const item = await ExternalOrderItem.create({ externalOrderId: order.id, title: 'x', inferredCategory: null, categoryOverride: null, confidence: null } as never);
  await TransactionOrderLink.create({ transactionId: txn.id, externalOrderId: order.id, status: 'accepted' } as never);

  // Simulate categorization writing a high-confidence category, then the trigger:
  await ExternalOrderItem.update({ inferredCategory: 'Groceries', confidence: 90 }, { where: { id: item.id } });
  await recomputeTransactionReviewFromItems(txn.id);

  assert.equal((await Transaction.findByPk(txn.id))!.reviewFlag, false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx tsx --import ./test/setup.ts --test test/recomputeTransactionReviewFromItems.test.ts`
Expected: PASS already for the direct-call test above (it exercises the function, not the wiring). This test guards the contract; Steps 3 wire the real callers. Proceed to wire and re-run.

- [ ] **Step 3: Wire the remaining trigger sites**

At each site below, after the item/link mutation is persisted, recompute the affected transactions. Add the import once per file:

```ts
import { transactionIdsForOrder, recomputeTransactionsReviewFromItems } from '../import/enrichment/recomputeTransactionReviewFromItems';
// (path is '../import/...' from routes/, './...' from within src/import/)
```

- `categorizeReceiptItems.ts` — at the end of `categorizeAndApplyReceiptItems(orderId, ...)`, after categories are written:
  ```ts
  await recomputeTransactionsReviewFromItems(await transactionIdsForOrder(orderId));
  ```
- `routes/externalOrders.ts` Amazon `/:id/categorize-items` — after categorization completes for `orderId`:
  ```ts
  await recomputeTransactionsReviewFromItems(await transactionIdsForOrder(orderId));
  ```
- `matchReceiptToTransactions.ts` — after accepted links are created for an order, recompute each newly-linked transaction id (you already have them in scope; otherwise `await transactionIdsForOrder(orderId)`).
- link reject/unlink route (search `status: 'rejected'` / link delete in `routes/`) — capture the `transactionId` before the status change, then `await recomputeTransactionsReviewFromItems([transactionId])`.
- `routes/receipts.ts` `POST /receipts/:id/analyze` — after items are created and (optionally) categorized for the receipt's `externalOrderId`:
  ```ts
  await recomputeTransactionsReviewFromItems(await transactionIdsForOrder(externalOrderId));
  ```

- [ ] **Step 4: Run tests**

Run: `cd backend && npx tsx --import ./test/setup.ts --test test/recomputeTransactionReviewFromItems.test.ts`
Expected: PASS (all).

- [ ] **Step 5: Commit**

```bash
git add backend/src/import/categorizeReceiptItems.ts backend/src/routes/externalOrders.ts backend/src/import/matchReceiptToTransactions.ts backend/src/routes/receipts.ts backend/test/recomputeTransactionReviewFromItems.test.ts
git commit --no-verify -m "feat(enrichment): recompute review on categorize/link/unlink/analyze"
```

---

## Task 6: `itemized` summary in the review list payload

**Files:**
- Modify: `backend/src/routes/transactions.ts` (the `GET /api/transactions` list serializer)
- Test: append to `backend/test/recomputeTransactionReviewFromItems.test.ts` (or a new `backend/test/transactionsItemizedSummary.test.ts`)

- [ ] **Step 1: Write the failing test**

```ts
// backend/test/transactionsItemizedSummary.test.ts
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { app } from '../src/app';
import { sequelize, Account, Household, Transaction, ExternalOrder, ExternalOrderItem, TransactionOrderLink } from '../src/models';

// ...set up household + private account (see recompute test for the pattern)...

test('itemized rows carry { itemCount, stragglerCount }', async () => {
  // one txn, accepted order, 3 items: 2 high-conf, 1 straggler
  // expect response row.itemized = { itemCount: 3, stragglerCount: 1 }
  // a non-itemized txn -> itemized === null
});
```

(Fill the setup using the same model-create pattern as Task 3's test. Assert against the JSON row for the itemized transaction and a plain one.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx tsx --import ./test/setup.ts --test test/transactionsItemizedSummary.test.ts`
Expected: FAIL — `itemized` undefined.

- [ ] **Step 3: Implement the summary**

In `backend/src/routes/transactions.ts`, after the page of transactions is loaded, compute the summary in one grouped query (avoid N+1). Add a helper:

```ts
import { enrichmentItemClearConfidence } from '../config/env';
import { TransactionOrderLink, ExternalOrderItem } from '../models';
import { QueryTypes } from 'sequelize';
import { sequelize } from '../models';

type ItemizedSummary = { itemCount: number; stragglerCount: number };

async function itemizedSummaries(txnIds: number[]): Promise<Map<number, ItemizedSummary>> {
  if (txnIds.length === 0) return new Map();
  const rows = await sequelize.query<{ transactionId: number; itemCount: number; stragglerCount: number }>(
    `SELECT tol.transaction_id AS "transactionId",
            COUNT(i.id) AS "itemCount",
            SUM(CASE WHEN (i.category_override IS NOT NULL AND i.category_override <> '')
                       OR (i.inferred_category IS NOT NULL AND i.inferred_category <> ''
                           AND i.confidence IS NOT NULL AND i.confidence >= :threshold)
                     THEN 0 ELSE 1 END) AS "stragglerCount"
       FROM transaction_order_links tol
       JOIN external_order_items i ON i.external_order_id = tol.external_order_id
      WHERE tol.status = 'accepted' AND tol.transaction_id IN (:ids)
      GROUP BY tol.transaction_id`,
    { type: QueryTypes.SELECT, replacements: { ids: txnIds, threshold: enrichmentItemClearConfidence } },
  );
  const map = new Map<number, ItemizedSummary>();
  for (const r of rows) {
    map.set(Number(r.transactionId), { itemCount: Number(r.itemCount), stragglerCount: Number(r.stragglerCount) });
  }
  return map;
}
```

Then in the list serializer, set `itemized: summaries.get(txn.id) ?? null` on each row.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && npx tsx --import ./test/setup.ts --test test/transactionsItemizedSummary.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/routes/transactions.ts backend/test/transactionsItemizedSummary.test.ts
git commit --no-verify -m "feat(transactions): itemized {itemCount,stragglerCount} summary in list payload"
```

---

## Task 7: Backfill sweep over existing itemized transactions

Fold a recompute sweep into the existing nightly `enrichment_backfill` tick so the
current queue shrinks, and make it idempotent.

**Files:**
- Modify: `backend/src/import/enrichmentBackfillScheduler.ts` (`runEnrichmentBackfillTick`)
- Test: append to `backend/test/recomputeTransactionReviewFromItems.test.ts`

- [ ] **Step 1: Write the failing test (append)**

```ts
import { backfillItemReviewClears } from '../src/import/enrichmentBackfillScheduler';

test('backfill clears pre-existing fully-categorized itemized txns and is idempotent', async () => {
  const txn = await Transaction.create({ accountId, date: '2026-05-04', amount: '-30.00', merchantRaw: 'COSTCO', txnType: 'purchase', reviewFlag: true, finalSplitType: 'me' } as never);
  await TransactionSignal.create({ transactionId: txn.id, source: 'item-link', confidence: 'medium', fields: { autoCategory: 'Mixed' } });
  const order = await ExternalOrder.create({ householdId, vendor: 'costco', total: '30.00', currency: 'CAD', orderDate: '2026-05-04' } as never);
  await ExternalOrderItem.create({ externalOrderId: order.id, title: 'x', inferredCategory: 'Groceries', categoryOverride: null, confidence: 90 } as never);
  await TransactionOrderLink.create({ transactionId: txn.id, externalOrderId: order.id, status: 'accepted' } as never);

  const first = await backfillItemReviewClears();
  assert.ok(first.recomputed >= 1);
  assert.equal((await Transaction.findByPk(txn.id))!.reviewFlag, false);

  const second = await backfillItemReviewClears(); // idempotent: no crash, flag stays false
  assert.equal((await Transaction.findByPk(txn.id))!.reviewFlag, false);
  assert.ok(second.recomputed >= 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx tsx --import ./test/setup.ts --test test/recomputeTransactionReviewFromItems.test.ts`
Expected: FAIL — `backfillItemReviewClears` not exported.

- [ ] **Step 3: Implement the sweep**

In `backend/src/import/enrichmentBackfillScheduler.ts`:

```ts
import { recomputeTransactionsReviewFromItems } from './enrichment/recomputeTransactionReviewFromItems';
import { TransactionOrderLink } from '../models';

/** Recompute item-based review-clear for every transaction with an accepted
 *  itemized link. Idempotent. Returns count recomputed. */
export async function backfillItemReviewClears(): Promise<{ recomputed: number }> {
  const links = await TransactionOrderLink.findAll({
    where: { status: 'accepted' },
    attributes: ['transactionId'],
  });
  const ids = [...new Set(links.map((l) => (l as unknown as { transactionId: number }).transactionId))];
  await recomputeTransactionsReviewFromItems(ids);
  return { recomputed: ids.length };
}
```

Then call it inside `runEnrichmentBackfillTick()` and include its result in the returned summary:

```ts
const itemReview = await backfillItemReviewClears();
// merge into the existing return, e.g. return { ...existing, itemReview };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && npx tsx --import ./test/setup.ts --test test/recomputeTransactionReviewFromItems.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/import/enrichmentBackfillScheduler.ts backend/test/recomputeTransactionReviewFromItems.test.ts
git commit --no-verify -m "feat(enrichment): backfill item-based review-clear in nightly tick"
```

---

## Task 8: Frontend transaction type gains `itemized`

**Files:**
- Modify: `frontend/src/types/api.ts` (the transaction list row type)

- [ ] **Step 1: Add the field**

Find the transaction list row interface (the type returned by `GET /api/transactions`). Add:

```ts
export interface ItemizedSummary {
  itemCount: number;
  stragglerCount: number;
}
// on the transaction row type:
  itemized?: ItemizedSummary | null;
```

- [ ] **Step 2: Typecheck**

Run: `cd frontend && npx tsc --noEmit`
Expected: PASS (no new type errors).

- [ ] **Step 3: Commit**

```bash
git add frontend/src/types/api.ts
git commit --no-verify -m "feat(frontend): itemized summary type on transaction row"
```

---

## Task 9: Review inbox — badge + expand-in-row

Render an itemized badge on review rows and let the reviewer fix stragglers inline,
reusing the existing per-item editor.

**Files:**
- Modify: `frontend/src/pages/ReviewInboxPage.tsx`
- Reuse: the `ItemRow` editing pattern from `frontend/src/components/ReceiptItemsDrawer.tsx` (category `<select>` → `patchJson('/api/external-order-items/:id', { categoryOverride })`; business → `{ businessUseOverride }`). Extract `ItemRow` into `frontend/src/components/items/ItemRow.tsx` if it is not already importable, so both the drawer and the inbox use one component (DRY).
- Test: `frontend/src/pages/ReviewInboxPage.test.tsx` (extend the existing tests if present)

- [ ] **Step 1: Write the failing component test**

```tsx
// in ReviewInboxPage.test.tsx
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
// mock GET /api/transactions to return one itemized row:
//   { id: 1, merchantRaw: 'COSTCO', itemized: { itemCount: 12, stragglerCount: 3 }, ... }
test('itemized review row shows the items badge', async () => {
  // render <ReviewInboxPage/> with the mocked fetch
  expect(await screen.findByText(/12 items/)).toBeInTheDocument();
  expect(screen.getByText(/3 need review/)).toBeInTheDocument();
});

test('expanding the badge lazy-loads the order items', async () => {
  // mock the order-items GET; click the badge; assert an item row renders
});
```

(Match the existing test harness/style in `frontend/src/pages/ReviewInboxPage.test.tsx` and the project's fetch-mock helper.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/pages/ReviewInboxPage.test.tsx`
Expected: FAIL — no badge rendered.

- [ ] **Step 3: Implement badge + expand**

In `ReviewInboxPage.tsx`, for each row where `txn.itemized != null`:

```tsx
{txn.itemized && (
  <button
    type="button"
    className="text-xs text-amber-700 hover:underline"
    onClick={() => toggleExpanded(txn.id)}
  >
    🧾 {txn.itemized.itemCount} items
    {txn.itemized.stragglerCount > 0 && ` · ${txn.itemized.stragglerCount} need review`}
  </button>
)}
```

- `toggleExpanded(txnId)` flips a `Set<number>` in component state.
- On first expand, fetch the order items for the transaction (reuse whatever endpoint `ReceiptItemsDrawer` uses to load an order's items; if it loads by `externalOrderId`, resolve the id from the transaction's accepted link via the existing receipts/order API). Cache in state keyed by `txnId`.
- Render the items with the shared `ItemRow`; **sort stragglers first** (those failing the bar — `!(categoryOverride || (inferredCategory && confidence >= 80))`), amber-marked; collapse/mute the rest.
- After an `ItemRow` save resolves, re-fetch that transaction's row (or call the list refresh) so a now-cleared transaction (its server `reviewFlag` flipped) animates out of the inbox. Keep the existing inbox refresh/optimistic mechanism.

- [ ] **Step 4: Run tests**

Run: `cd frontend && npx vitest run src/pages/ReviewInboxPage.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/pages/ReviewInboxPage.tsx frontend/src/components/items/ItemRow.tsx frontend/src/components/ReceiptItemsDrawer.tsx frontend/src/pages/ReviewInboxPage.test.tsx
git commit --no-verify -m "feat(review): itemized badge + expand-in-row straggler fixing"
```

---

## Task 10: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Backend test suite**

Run: `cd backend && yarn test`
Expected: PASS, including the new `transactionClearsFromItems`, `recomputeTransactionReviewFromItems`, and `transactionsItemizedSummary` files.

- [ ] **Step 2: Backend typecheck + lint**

Run: `cd backend && npx tsc --noEmit && yarn lint`
Expected: clean. (Run lint manually since the pre-commit hook is disabled in this worktree.)

- [ ] **Step 3: Frontend test + typecheck + lint**

Run: `cd frontend && npx vitest run && npx tsc --noEmit && yarn lint`
Expected: clean.

- [ ] **Step 4: Manual smoke (optional, requires OpenAI key + a real Costco/Amazon receipt)**

Import or attach a multi-category itemized receipt, confirm: a fully high-confidence one does NOT appear in the review inbox; a partially-categorized one appears with the `🧾 … need review` badge; fixing the last straggler removes it from the inbox; run the nightly backfill (`enrichment_backfill` job) and confirm pre-existing itemized transactions drop out.

- [ ] **Step 5: Final commit (if any lint fixes)**

```bash
git add -A && git commit --no-verify -m "chore: lint/typecheck fixes for item-review mechanic"
```

---

## Self-Review notes (author)

- **Spec coverage:** per-item bar (Task 2), per-transaction OR-clear with stateless baseline (Task 3), all six recompute triggers (Tasks 4-5), `itemized` list summary (Task 6), backfill (Task 7), frontend badge + expand-in-row reusing `ItemRow` (Tasks 8-9), Model A display unchanged (no `linkItemsStage`/`computeReviewFlag` rewrite — confirmed: only additive). Confidence threshold env (Task 1).
- **Type consistency:** `ItemClearInput` (Task 2) is reused by Task 3; `recomputeTransactionsReviewFromItems` / `transactionIdsForOrder` (Task 3) are the only symbols Tasks 4-5-7 import; `ItemizedSummary` (Task 6 backend shape) mirrors Task 8 frontend type.
- **Known adaptation points flagged inline:** the env single-file import suffix (Task 1 Step 4), the route-test auth helper (Task 4), the exact item-load endpoint the inbox reuses (Task 9). These depend on existing test/util conventions the implementer can read directly.
