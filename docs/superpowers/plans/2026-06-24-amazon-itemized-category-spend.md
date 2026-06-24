# Amazon Itemized Category Spend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Amazon (and any itemized-order vendor) spend decompose into the categories of the items actually purchased, in the spend-by-category reporting surface — instead of one opaque category per transaction.

**Architecture:** Three phases. (1) Close the accept loop so high-confidence Amazon order links auto-accept (reusing the receipt path's `decideAutoAccept`), since `loadItemAllocationContext` only reads `status='accepted'` links. (2) Wire the existing `splitTxnByItems` decomposition into `GET /api/v1/spending/by-category`. (3) Raise the matchable-order pool by fixing the email parser (dropped tax/subtotal, missing date/last4) and tuning matcher recall.

**Tech Stack:** Express + Sequelize (dual-dialect SQLite/Postgres), `node:test` via `tsx` for backend, Vite + React 19 + vitest for frontend, TypeScript throughout.

## Global Constraints

- Backend tests are `node:test` via `tsx`, colocated `*.test.ts` beside source under `backend/src/`. Run one file: `cd backend && yarn tsx --import ./test/setup.ts --test src/path/to/file.test.ts`. Filter by name: append `--test-name-pattern '<regex>'`.
- Sequelize must run on **both** SQLite (default) and Postgres. No dialect-specific SQL.
- Money columns are `DECIMAL` → surfaced as **strings** in JS; coerce with `Number(...)` and guard `Number.isFinite`.
- Sequelize camelCase ↔ Postgres snake_case is handled by `underscored: true` model config — write camelCase in code.
- `decideAutoAccept` policy is fixed: auto-accept when top confidence **≥ 85 AND** leads the runner-up by **> 10**; otherwise leave `suggested`.
- Never duplicate the auto-accept decision — there is exactly one `decideAutoAccept`.
- Commit after every green step. No `Co-Authored-By` trailers.
- Worktree husky hook calls `yarn` and fails in worktrees with no `node_modules`; if a commit is blocked by the hook on a code change, fix the install rather than bypassing. Doc-only commits may use `--no-verify`.

---

## File Structure

**Phase 1 — accept loop**
- Create `backend/src/amazon/autoAccept.ts` — leaf module: `decideAutoAccept` + `AUTO_ACCEPT_THRESHOLD`/`AUTO_ACCEPT_MARGIN` (moved from `matchReceiptToTransactions.ts`). No imports → no cycle.
- Modify `backend/src/import/matchReceiptToTransactions.ts` — import `decideAutoAccept` from the new module instead of defining it.
- Modify `backend/src/import/matchReceiptToTransactions.test.ts` — re-point the `decideAutoAccept` import.
- Modify `backend/src/amazon/matcher.ts` — per-transaction auto-accept in `runAmazonMatching`; post-accept recompute.
- Create `backend/src/amazon/backfillAutoAcceptLinks.ts` — one-shot promotion of existing `suggested` Amazon links that now qualify.
- Modify `frontend/src/...` Amazon review surface — one-click accept/reject for the 75–84 band (Task 4 locates the exact file).

**Phase 2 — reporting wire**
- Create `backend/src/routes/spendByCategoryDecompose.ts` — pure `aggregateSpendByCategoryDecomposed(...)` that decomposes linked rows via `splitTxnByItems`, returning the same shape as `aggregateSpendByCategoryId`.
- Modify `backend/src/routes/reporting.ts` — load allocation context, select `id`, swap the aggregator.

**Phase 3 — grow the pool**
- Modify `backend/src/integrations/parsers/amazon.ts` — populate structured `subtotal`/`tax`/`shipping`, currency, harden `order_date`/`last4`, add format coverage.
- Modify `backend/src/integrations/parsers/amazonEmailParser.test.ts` — fixtures.
- Modify `backend/src/amazon/matcher.ts` — `selectMatchCandidates` tie-break.

---

## Phase 1 — Close the accept loop

### Task 1: Extract `decideAutoAccept` into a leaf module

**Files:**
- Create: `backend/src/amazon/autoAccept.ts`
- Modify: `backend/src/import/matchReceiptToTransactions.ts:28-43`
- Modify: `backend/src/import/matchReceiptToTransactions.test.ts` (import line)
- Test: `backend/src/amazon/autoAccept.test.ts`

**Interfaces:**
- Produces: `decideAutoAccept(sortedConfidences: number[]): boolean`, `AUTO_ACCEPT_THRESHOLD = 85`, `AUTO_ACCEPT_MARGIN = 10` — all exported from `backend/src/amazon/autoAccept.ts`. Pure, no imports.

- [ ] **Step 1: Write the failing test**

```ts
// backend/src/amazon/autoAccept.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideAutoAccept, AUTO_ACCEPT_THRESHOLD, AUTO_ACCEPT_MARGIN } from './autoAccept';

test('constants match the fixed policy', () => {
  assert.equal(AUTO_ACCEPT_THRESHOLD, 85);
  assert.equal(AUTO_ACCEPT_MARGIN, 10);
});

test('empty → false', () => {
  assert.equal(decideAutoAccept([]), false);
});

test('sole candidate ≥85 → true', () => {
  assert.equal(decideAutoAccept([90]), true);
});

test('sole candidate <85 → false', () => {
  assert.equal(decideAutoAccept([84]), false);
});

test('top ≥85 but margin not strictly >10 → false', () => {
  assert.equal(decideAutoAccept([90, 80]), false); // margin exactly 10
});

test('top ≥85 and margin >10 → true', () => {
  assert.equal(decideAutoAccept([90, 79]), true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && yarn tsx --import ./test/setup.ts --test src/amazon/autoAccept.test.ts`
Expected: FAIL — cannot find module `./autoAccept`.

- [ ] **Step 3: Create the leaf module**

```ts
// backend/src/amazon/autoAccept.ts
/**
 * Pure auto-accept decision shared by the Amazon order matcher and the
 * vendor-generic receipt matcher. No imports — safe for either side to depend
 * on without creating a module cycle.
 */
export const AUTO_ACCEPT_THRESHOLD = 85; // exact-amount match baseline is 90 (50 amount + 25 date + 15 vendor)
export const AUTO_ACCEPT_MARGIN = 10; // best must lead runner-up by MORE than this to be unambiguous

/**
 * Decide whether the top-scored candidate is safe to auto-accept: high enough
 * confidence AND unambiguous (sole qualifier, or a clear margin over the
 * runner-up). `sortedConfidences` is sorted descending.
 */
export function decideAutoAccept(sortedConfidences: number[]): boolean {
  if (sortedConfidences.length === 0) return false;
  if (sortedConfidences[0] < AUTO_ACCEPT_THRESHOLD) return false;
  if (sortedConfidences.length === 1) return true;
  return sortedConfidences[0] - sortedConfidences[1] > AUTO_ACCEPT_MARGIN;
}
```

- [ ] **Step 4: Re-point `matchReceiptToTransactions.ts`**

Delete the local definition (lines 28-43: the two `AUTO_ACCEPT_*` consts and the `decideAutoAccept` function) and import instead. Add near the top imports:

```ts
import { decideAutoAccept } from '../amazon/autoAccept';
```

Keep `MATCH_CONFIDENCE_THRESHOLD` and `DATE_WINDOW_DAYS` where they are — those stay receipt-local. If any code in this file referenced `AUTO_ACCEPT_THRESHOLD`/`AUTO_ACCEPT_MARGIN` directly, import them from `../amazon/autoAccept` too (grep first: `grep -n AUTO_ACCEPT backend/src/import/matchReceiptToTransactions.ts`).

- [ ] **Step 5: Re-point the existing test import**

In `backend/src/import/matchReceiptToTransactions.test.ts`, change the `decideAutoAccept` import source from `./matchReceiptToTransactions` to `../amazon/autoAccept`. (Grep: `grep -n decideAutoAccept backend/src/import/matchReceiptToTransactions.test.ts`. If the test imports it from the receipt module, re-point only that symbol; leave other imports from the receipt module intact.)

- [ ] **Step 6: Run both test files**

Run:
```
cd backend && yarn tsx --import ./test/setup.ts --test src/amazon/autoAccept.test.ts src/import/matchReceiptToTransactions.test.ts
```
Expected: PASS (all).

- [ ] **Step 7: Typecheck**

Run: `yarn workspace cashflow-backend run typecheck`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add backend/src/amazon/autoAccept.ts backend/src/amazon/autoAccept.test.ts backend/src/import/matchReceiptToTransactions.ts backend/src/import/matchReceiptToTransactions.test.ts
git commit -m "refactor(amazon): extract decideAutoAccept into shared leaf module"
```

---

### Task 2: Auto-accept high-confidence links in `runAmazonMatching`

**Files:**
- Modify: `backend/src/amazon/matcher.ts:121-198`
- Test: `backend/src/amazon/matcher.test.ts` (create if absent)

**Interfaces:**
- Consumes: `decideAutoAccept` from `./autoAccept`; `recomputeTransactionsReviewFromItems`, `transactionIdsForOrder` from `../import/enrichment/recomputeTransactionReviewFromItems`.
- Changes `upsertSuggestedOrderLink` to accept an optional `autoAccept?: boolean`; when true and the link is newly created (or still `suggested`), it sets/keeps `status='accepted'`. Returns `{ created: boolean; accepted: boolean }`.
- `runAmazonMatching` return type gains `autoAccepted: number`.

- [ ] **Step 1: Write the failing test**

```ts
// backend/src/amazon/matcher.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Transaction, ExternalOrder, TransactionOrderLink } from '../models';
import { runAmazonMatching } from './matcher';

// test/setup.ts gives each process a fresh SQLite DB with synced models.
async function seedHousehold(householdId: number) {
  // An Amazon txn that should score ≥85 against exactly one order:
  // amount within $0.50 (+50) + date 1 day after order (+25) + merchant Amazon (+15) = 90.
  const txn = await Transaction.create({
    householdId, accountId: 1, date: '2026-06-10', amount: '-50.36', currency: 'CAD',
    merchantRaw: 'AMZN MKTP CA*ABC', merchantClean: 'Amazon', txnType: null,
  } as never);
  const order = await ExternalOrder.create({
    householdId, vendor: 'amazon', orderDate: '2026-06-09', total: '50.36', currency: 'CAD',
    source: 'test', dedupeKey: `t-${householdId}-1`,
  } as never);
  return { txn, order };
}

test('runAmazonMatching auto-accepts a sole ≥85 candidate', async () => {
  const householdId = 9001;
  const { txn, order } = await seedHousehold(householdId);
  const res = await runAmazonMatching({ householdId });
  assert.ok(res.autoAccepted >= 1, 'expected at least one auto-accept');
  const link = await TransactionOrderLink.findOne({
    where: { transactionId: (txn as { id: number }).id, externalOrderId: (order as { id: number }).id },
  });
  assert.equal(link?.status, 'accepted');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && yarn tsx --import ./test/setup.ts --test src/amazon/matcher.test.ts`
Expected: FAIL — `res.autoAccepted` is undefined / link status is `suggested`.

- [ ] **Step 3: Add the import and extend `upsertSuggestedOrderLink`**

At the top of `backend/src/amazon/matcher.ts`, add:

```ts
import { decideAutoAccept } from './autoAccept';
```

Replace `upsertSuggestedOrderLink` (lines 121-144) with:

```ts
export async function upsertSuggestedOrderLink(args: {
  transactionId: number;
  externalOrderId: number;
  confidence: number;
  matchReason: string;
  autoAccept?: boolean;
  transaction?: DbTransaction;
}): Promise<{ created: boolean; accepted: boolean }> {
  const { transactionId, externalOrderId, confidence, matchReason, autoAccept, transaction } = args;
  const status = autoAccept ? 'accepted' : 'suggested';
  const [link, created] = await TransactionOrderLink.findOrCreate({
    where: { transactionId, externalOrderId },
    defaults: {
      transactionId,
      externalOrderId,
      confidence: String(confidence),
      matchReason,
      status,
    },
    transaction,
  });
  if (!created && link.status === 'suggested') {
    // Refresh score/reason; promote to accepted if this run qualifies. Never
    // touch an already-accepted or user-rejected row.
    await link.update(
      { confidence: String(confidence), matchReason, ...(autoAccept ? { status: 'accepted' as const } : {}) },
      { transaction },
    );
  }
  return { created, accepted: link.status === 'accepted' };
}
```

- [ ] **Step 4: Apply the auto-accept decision in `runAmazonMatching`**

In `runAmazonMatching`, add the recompute import at the top of the file:

```ts
import {
  recomputeTransactionsReviewFromItems,
  transactionIdsForOrder,
} from '../import/enrichment/recomputeTransactionReviewFromItems';
```

Replace the per-transaction loop body (lines 179-195) with:

```ts
  let autoAccepted = 0;
  const acceptedOrderIds = new Set<number>();

  for (const txn of txns.filter((row) => isAmazonLikeMerchant(`${row.merchantRaw} ${row.merchantClean}`))) {
    const scores = orders.map((order) => ({ order, ...scoreAmazonOrderMatch(txn, order) }));
    const candidates = selectMatchCandidates(scores);
    // Per-transaction auto-accept: only when there is a single candidate and it
    // is unambiguous + ≥ threshold. A transaction spanning multiple confident
    // orders is never auto-accepted (genuinely ambiguous which order it is).
    const sortedConf = candidates.map((c) => c.confidence).sort((a, b) => b - a);
    const auto = candidates.length === 1 && decideAutoAccept(sortedConf);
    for (const candidate of candidates) {
      const { created, accepted } = await upsertSuggestedOrderLink({
        transactionId: txn.id,
        externalOrderId: candidate.order.id,
        confidence: candidate.confidence,
        matchReason: candidate.matchReason,
        autoAccept: auto,
      });
      if (created) {
        suggested += 1;
        if (matchedDateFrom == null || txn.date < matchedDateFrom) matchedDateFrom = txn.date;
        if (matchedDateTo == null || txn.date > matchedDateTo) matchedDateTo = txn.date;
      }
      if (auto && accepted) {
        autoAccepted += 1;
        acceptedOrderIds.add(candidate.order.id);
      }
    }
  }

  // Mirror the manual-accept side effect (routes/amazon.ts /links/:id/accept):
  // accepted item links can clear the transaction's review flag.
  for (const orderId of acceptedOrderIds) {
    await recomputeTransactionsReviewFromItems(await transactionIdsForOrder(orderId));
  }

  return { suggested, autoAccepted, scannedTransactions: txns.length, matchedDateFrom, matchedDateTo };
}
```

Update the return type annotation of `runAmazonMatching` to add `autoAccepted: number;`.

- [ ] **Step 5: Run the test**

Run: `cd backend && yarn tsx --import ./test/setup.ts --test src/amazon/matcher.test.ts`
Expected: PASS.

- [ ] **Step 6: Check callers compile**

`upsertSuggestedOrderLink` now returns an object, not a boolean. Grep callers: `grep -rn "upsertSuggestedOrderLink" backend/src --include=*.ts | grep -v test`. Update any caller that used the boolean return (e.g. `if (created)`) to destructure `{ created }`. Then:

Run: `yarn workspace cashflow-backend run typecheck`
Expected: no errors.

- [ ] **Step 7: Run the broader matching + capture tests**

Run:
```
cd backend && yarn tsx --import ./test/setup.ts --test src/amazon/matcher.test.ts src/amazon/amazonPipeline.test.ts
```
Expected: PASS. (If `amazonPipeline.test.ts` asserts a `suggested`-only outcome that now auto-accepts, update that expectation to match the policy and note it in the commit.)

- [ ] **Step 8: Commit**

```bash
git add backend/src/amazon/matcher.ts backend/src/amazon/matcher.test.ts
git commit -m "feat(amazon): auto-accept sole high-confidence order links during matching"
```

---

### Task 3: Backfill existing `suggested` Amazon links that now qualify

**Files:**
- Create: `backend/src/amazon/backfillAutoAcceptLinks.ts`
- Test: `backend/src/amazon/backfillAutoAcceptLinks.test.ts`

**Interfaces:**
- Produces: `backfillAutoAcceptAmazonLinks(args: { householdId: number }): Promise<{ promoted: number; examined: number }>`. For each Amazon transaction's set of current `suggested` links, applies the same `candidates.length === 1 && decideAutoAccept([conf])` rule and promotes qualifying links to `accepted`, then runs `recomputeTransactionsReviewFromItems`. Idempotent.

- [ ] **Step 1: Write the failing test**

```ts
// backend/src/amazon/backfillAutoAcceptLinks.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Transaction, ExternalOrder, TransactionOrderLink } from '../models';
import { backfillAutoAcceptAmazonLinks } from './backfillAutoAcceptLinks';

test('promotes a sole suggested ≥85 link to accepted; leaves an ambiguous pair', async () => {
  const householdId = 9101;
  const txnSolo = await Transaction.create({
    householdId, accountId: 1, date: '2026-06-10', amount: '-20.00', currency: 'CAD',
    merchantRaw: 'AMZN', merchantClean: 'Amazon',
  } as never);
  const orderSolo = await ExternalOrder.create({
    householdId, vendor: 'amazon', orderDate: '2026-06-09', total: '20.00', currency: 'CAD',
    source: 'test', dedupeKey: `b-${householdId}-1`,
  } as never);
  await TransactionOrderLink.create({
    transactionId: (txnSolo as { id: number }).id, externalOrderId: (orderSolo as { id: number }).id,
    confidence: '90', matchReason: 'seed', status: 'suggested',
  } as never);

  const res = await backfillAutoAcceptAmazonLinks({ householdId });
  assert.equal(res.promoted, 1);

  const link = await TransactionOrderLink.findOne({
    where: { transactionId: (txnSolo as { id: number }).id },
  });
  assert.equal(link?.status, 'accepted');

  // Idempotent: second run promotes nothing.
  const again = await backfillAutoAcceptAmazonLinks({ householdId });
  assert.equal(again.promoted, 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && yarn tsx --import ./test/setup.ts --test src/amazon/backfillAutoAcceptLinks.test.ts`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Implement the backfill**

```ts
// backend/src/amazon/backfillAutoAcceptLinks.ts
import { Op } from 'sequelize';
import { Transaction, TransactionOrderLink } from '../models';
import { decideAutoAccept } from './autoAccept';
import { isAmazonLikeMerchant } from './matcher';
import {
  recomputeTransactionsReviewFromItems,
  transactionIdsForOrder,
} from '../import/enrichment/recomputeTransactionReviewFromItems';

/**
 * One-shot promotion of pre-existing 'suggested' Amazon links created before
 * auto-accept existed. A transaction's links are promoted only when there is
 * exactly ONE suggested link for it and that link clears decideAutoAccept —
 * the same unambiguity rule runAmazonMatching applies live. Idempotent:
 * already-accepted/rejected links are ignored.
 */
export async function backfillAutoAcceptAmazonLinks(args: {
  householdId: number;
}): Promise<{ promoted: number; examined: number }> {
  const txns = await Transaction.findAll({ where: { householdId: args.householdId } });
  const amazonTxnIds = txns
    .filter((t) => isAmazonLikeMerchant(`${t.merchantRaw} ${t.merchantClean}`))
    .map((t) => t.id);
  if (amazonTxnIds.length === 0) return { promoted: 0, examined: 0 };

  const suggested = await TransactionOrderLink.findAll({
    where: { transactionId: { [Op.in]: amazonTxnIds }, status: 'suggested' },
  });

  const byTxn = new Map<number, TransactionOrderLink[]>();
  for (const l of suggested) {
    const list = byTxn.get(l.transactionId) ?? [];
    list.push(l);
    byTxn.set(l.transactionId, list);
  }

  let promoted = 0;
  const acceptedOrderIds = new Set<number>();
  for (const [, links] of byTxn) {
    if (links.length !== 1) continue; // ambiguous — leave for manual review
    const link = links[0];
    if (!decideAutoAccept([Number(link.confidence)])) continue;
    await link.update({ status: 'accepted' });
    promoted += 1;
    acceptedOrderIds.add(link.externalOrderId);
  }

  for (const orderId of acceptedOrderIds) {
    await recomputeTransactionsReviewFromItems(await transactionIdsForOrder(orderId));
  }

  return { promoted, examined: suggested.length };
}
```

- [ ] **Step 4: Run the test**

Run: `cd backend && yarn tsx --import ./test/setup.ts --test src/amazon/backfillAutoAcceptLinks.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `yarn workspace cashflow-backend run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add backend/src/amazon/backfillAutoAcceptLinks.ts backend/src/amazon/backfillAutoAcceptLinks.test.ts
git commit -m "feat(amazon): backfill auto-accept for pre-existing suggested links"
```

> **Running the backfill against prod** is a manual, supervised step done after merge — not part of this plan's automated flow. It is invoked per household.

---

### Task 4: Frontend one-click review for the 75–84 band

**Files:**
- Modify: the Amazon links review surface. Locate it first: `grep -rn "links/manual\|/links/.*accept\|orderLinks\|transaction-link" frontend/src` and `grep -rln "amazon" frontend/src/pages frontend/src/components`. The accept/reject endpoints are `POST /api/amazon/links/:id/accept` and `POST /api/amazon/links/:id/reject` (see `backend/src/routes/amazon.ts:351-386`).
- Test: colocated `*.test.tsx` beside the component (vitest).

**Interfaces:**
- Consumes: existing API client in `frontend/src/lib/api.ts`. Add client methods `acceptAmazonLink(id)` / `rejectAmazonLink(id)` if absent (mirror existing POST helpers).

- [ ] **Step 1: Locate the surface and confirm the gap**

Run the greps above. Identify the component listing Amazon transactions with their `orderLinks`. Confirm whether it already renders `suggested` links with accept/reject controls. If a control already exists and simply isn't surfaced for `suggested` links, the change is to render it; if no surface exists, add a compact "Pending Amazon matches" list.

- [ ] **Step 2: Write the failing component test**

Write a vitest test rendering the component with a mocked transaction carrying one `suggested` orderLink (confidence 80), asserting an Accept control appears and clicking it calls the accept client method with the link id. (Mock `frontend/src/lib/api.ts`.) Match the existing test style in the same directory.

Run: `yarn workspace frontend run test <ComponentName>`
Expected: FAIL.

- [ ] **Step 3: Implement the control**

Render Accept/Reject for `status === 'suggested'` links, wired to the client methods, showing the candidate order's item titles (already present on the link's `order.items`). Use design-system primitives as-is (no DS overrides); app-side Tailwind only for layout. Optimistically remove the row on success; surface errors.

- [ ] **Step 4: Run the test**

Run: `yarn workspace frontend run test <ComponentName>`
Expected: PASS.

- [ ] **Step 5: Frontend typecheck + lint**

Run: `yarn workspace frontend run lint`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add frontend/src
git commit -m "feat(frontend): one-click accept/reject for suggested Amazon order links"
```

---

## Phase 2 — Wire `splitTxnByItems` into reporting

### Task 5: Pure decomposing aggregator

**Files:**
- Create: `backend/src/routes/spendByCategoryDecompose.ts`
- Test: `backend/src/routes/spendByCategoryDecompose.test.ts`

**Interfaces:**
- Consumes: `splitTxnByItems`, `AllocatorTxn`, `ItemAllocationContext` (from `../summary/loadItemAllocations`), `CategoryTree` (from `../categories/...`), `isNonSpend`.
- Produces:
```ts
export type DecomposeRow = {
  id: number;
  amount: unknown;
  finalCategory: string | null;
  finalCategoryId: number | null;
  txnType: string | null;
  accountType: string | null;
};
export function aggregateSpendByCategoryDecomposed(
  rows: DecomposeRow[],
  tree: CategoryTree,
  ctx: ItemAllocationContext,
  currency: string,
): { amountById: Map<number, number>; countById: Map<number, number>; uncat: number; uncatCount: number };
```
- Semantics: a transaction with accepted links is decomposed via `splitTxnByItems`; each allocation's `Math.abs(amount)` is added to `amountById[categoryId]` (or `uncat` when the allocation's categoryId is null or not in the tree). A decomposed transaction increments `countById` **once per distinct category it touches**. Non-decomposed rows behave exactly like `aggregateSpendByCategoryId`. The grand total (Σ amounts + uncat) is invariant vs `aggregateSpendByCategoryId` because `splitTxnByItems` reconciles allocations to the transaction amount.

- [ ] **Step 1: Write the failing tests**

```ts
// backend/src/routes/spendByCategoryDecompose.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aggregateSpendByCategoryDecomposed } from './spendByCategoryDecompose';
import type { ItemAllocationContext } from '../summary/loadItemAllocations';

// Minimal tree: ids 10 (Coffee), 20 (Books), both roots.
const tree = {
  parentById: new Map<number, number | null>([[10, null], [20, null]]),
  nameById: new Map([[10, 'Coffee'], [20, 'Books']]),
  depthById: new Map([[10, 0], [20, 0]]),
  pathById: new Map([[10, 'Coffee'], [20, 'Books']]),
} as unknown as Parameters<typeof aggregateSpendByCategoryDecomposed>[1];

const emptyCtx: ItemAllocationContext = {
  linksByTxn: new Map(), ordersById: new Map(), itemsByOrder: new Map(),
};

test('no links → identical to direct aggregation', () => {
  const rows = [
    { id: 1, amount: '-50.00', finalCategory: 'Coffee', finalCategoryId: 10, txnType: null, accountType: null },
  ];
  const r = aggregateSpendByCategoryDecomposed(rows, tree, emptyCtx, 'CAD');
  assert.equal(r.amountById.get(10), 50);
  assert.equal(r.uncat, 0);
});

test('linked mixed order splits across categories; total invariant', () => {
  const rows = [
    { id: 2, amount: '-200.00', finalCategory: 'Coffee', finalCategoryId: 10, txnType: null, accountType: null },
  ];
  const ctx: ItemAllocationContext = {
    linksByTxn: new Map([[2, [{ externalOrderId: 99, linkedAmount: null }]]]),
    ordersById: new Map([[99, { id: 99, subtotal: null, tax: null, shipping: null, total: '200.00', currency: 'CAD' }]]),
    itemsByOrder: new Map([[99, [
      { id: 1, totalPrice: '150.00', unitPrice: null, quantity: 1, inferredCategory: 'Coffee', inferredCategoryId: 10, categoryOverride: null, categoryOverrideId: null, businessUsePercent: null, businessUseOverride: null },
      { id: 2, totalPrice: '50.00', unitPrice: null, quantity: 1, inferredCategory: 'Books', inferredCategoryId: 20, categoryOverride: null, categoryOverrideId: null, businessUsePercent: null, businessUseOverride: null },
    ]]]),
  };
  const r = aggregateSpendByCategoryDecomposed(rows, tree, ctx, 'CAD');
  assert.equal(Math.round((r.amountById.get(10) ?? 0) * 100) / 100, 150);
  assert.equal(Math.round((r.amountById.get(20) ?? 0) * 100) / 100, 50);
  const total = (r.amountById.get(10) ?? 0) + (r.amountById.get(20) ?? 0) + r.uncat;
  assert.equal(Math.round(total * 100) / 100, 200); // invariant
  assert.equal(r.countById.get(10), 1);
  assert.equal(r.countById.get(20), 1); // counted once per distinct category
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && yarn tsx --import ./test/setup.ts --test src/routes/spendByCategoryDecompose.test.ts`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Implement the aggregator**

```ts
// backend/src/routes/spendByCategoryDecompose.ts
import { splitTxnByItems, type AllocatorTxn } from '../import/splitTxnByItems';
import type { ItemAllocationContext } from '../summary/loadItemAllocations';
import type { CategoryTree } from '../categories/rollup';
import { isNonSpend } from './reportingShared'; // see Step 4 for the export location

export type DecomposeRow = {
  id: number;
  amount: unknown;
  finalCategory: string | null;
  finalCategoryId: number | null;
  txnType: string | null;
  accountType: string | null;
};

function num(v: unknown): number | null {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Spend-by-category that decomposes accepted-linked itemized transactions into
 * their per-item categories (via splitTxnByItems), falling back to the txn's
 * own finalCategory when it has no usable links. Same return shape as the
 * direct aggregator; grand total is invariant because splitTxnByItems
 * reconciles allocations to the transaction amount (it books rounding/
 * uncategorized drift back to finalCategory).
 */
export function aggregateSpendByCategoryDecomposed(
  rows: DecomposeRow[],
  tree: CategoryTree,
  ctx: ItemAllocationContext,
  currency: string,
): { amountById: Map<number, number>; countById: Map<number, number>; uncat: number; uncatCount: number } {
  const amountById = new Map<number, number>();
  const countById = new Map<number, number>();
  let uncat = 0;
  let uncatCount = 0;

  const bump = (id: number | null, amount: number, touched: Set<number | null>) => {
    if (id != null && tree.parentById.has(id)) {
      amountById.set(id, (amountById.get(id) ?? 0) + amount);
      touched.add(id);
    } else {
      uncat += amount;
      touched.add(null);
    }
  };

  for (const t of rows) {
    if (isNonSpend(t.txnType, t.accountType ?? null)) continue;
    const a = num(t.amount);
    if (a == null) continue;

    const links = ctx.linksByTxn.get(t.id);
    const touched = new Set<number | null>();

    if (links && links.length > 0) {
      const allocatorTxn: AllocatorTxn = {
        id: t.id,
        amount: String(a),
        currency,
        finalCategory: t.finalCategory,
        finalCategoryId: t.finalCategoryId,
        finalBusiness: false,
        finalSplitType: '',
        businessAmount: '0',
      };
      const allocations = splitTxnByItems({
        txn: allocatorTxn,
        links,
        ordersById: ctx.ordersById,
        itemsByOrder: ctx.itemsByOrder,
      });
      for (const alloc of allocations) {
        bump(alloc.categoryId, Math.abs(alloc.amount), touched);
      }
    } else {
      bump(t.finalCategoryId, Math.abs(a), touched);
    }

    // One count per distinct category this transaction touched.
    for (const id of touched) {
      if (id == null) uncatCount += 1;
      else countById.set(id, (countById.get(id) ?? 0) + 1);
    }
  }

  return { amountById, countById, uncat, uncatCount };
}
```

- [ ] **Step 4: Make `isNonSpend` importable**

`isNonSpend` currently lives in `backend/src/routes/reporting.ts`. Grep: `grep -n "isNonSpend" backend/src/routes/reporting.ts`. If it is not exported, extract it (and any constant it depends on) into `backend/src/routes/reportingShared.ts`, export it, and import it back into `reporting.ts`. If extracting is disproportionate, instead export `isNonSpend` from `reporting.ts` and import from there (adjust the import in Step 3). Pick the smaller diff; do not duplicate the function.

- [ ] **Step 5: Run the tests**

Run: `cd backend && yarn tsx --import ./test/setup.ts --test src/routes/spendByCategoryDecompose.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck + commit**

Run: `yarn workspace cashflow-backend run typecheck` → no errors.

```bash
git add backend/src/routes/spendByCategoryDecompose.ts backend/src/routes/spendByCategoryDecompose.test.ts backend/src/routes/reporting.ts backend/src/routes/reportingShared.ts
git commit -m "feat(reporting): pure item-decomposing spend-by-category aggregator"
```

---

### Task 6: Wire the decomposing aggregator into `GET /api/v1/spending/by-category`

**Files:**
- Modify: `backend/src/routes/reporting.ts:616-723`
- Test: `backend/src/routes/reporting.test.ts` (extend)

**Interfaces:**
- Consumes: `aggregateSpendByCategoryDecomposed` (Task 5), `loadItemAllocationContext` (from `../summary/loadItemAllocations`).

- [ ] **Step 1: Write the failing integration test**

In `backend/src/routes/reporting.test.ts`, add a test that: seeds two CAD spend transactions in-window (one with an `accepted` link to a two-item order spanning two categories, one plain), calls the by-category handler (follow the existing test's invocation style in that file), and asserts (a) the mixed transaction's spend appears split across both item categories, and (b) the response's summed category spend equals the summed transaction spend (invariant). Mirror the existing seeding helpers in the file.

Run: `cd backend && yarn tsx --import ./test/setup.ts --test src/routes/reporting.test.ts --test-name-pattern 'by-category'`
Expected: FAIL (current handler does not split).

- [ ] **Step 2: Select `id` and load allocation context for both periods**

In the `GET /spending/by-category` handler:

Add `id` (and keep the existing fields) to BOTH `attributes` arrays:

```ts
attributes: ['id', 'amount', 'finalCategory', 'finalCategoryId', 'txnType'],
```

After the two `Transaction.findAll` resolve, add the import at the top of the file:

```ts
import { loadItemAllocationContext } from '../summary/loadItemAllocations';
import { aggregateSpendByCategoryDecomposed } from './spendByCategoryDecompose';
```

and load context for the union of current+previous transaction ids:

```ts
const currIds = (currTxns as Array<{ id: number }>).map((r) => r.id);
const prevIds = (prevTxns as Array<{ id: number }>).map((r) => r.id);
const allocCtx = await loadItemAllocationContext([...currIds, ...prevIds]);
```

- [ ] **Step 3: Swap the aggregator calls**

Replace:

```ts
const curr = aggregateSpendByCategoryId(currTxns as unknown as SpendRow[], tree);
const prev = aggregateSpendByCategoryId(prevTxns as unknown as SpendRow[], tree);
```

with a row-mapping (the decomposer takes a flat `accountType`, not the nested `'account.accountType'` key) and the new calls:

```ts
const toDecomposeRows = (rows: unknown[]) =>
  (rows as Array<Record<string, unknown>>).map((r) => ({
    id: Number(r.id),
    amount: r.amount,
    finalCategory: (r.finalCategory as string | null) ?? null,
    finalCategoryId: (r.finalCategoryId as number | null) ?? null,
    txnType: (r.txnType as string | null) ?? null,
    accountType: (r['account.accountType'] as string | null) ?? null,
  }));

const curr = aggregateSpendByCategoryDecomposed(toDecomposeRows(currTxns), tree, allocCtx, currency);
const prev = aggregateSpendByCategoryDecomposed(toDecomposeRows(prevTxns), tree, allocCtx, currency);
```

Everything downstream (`directAmountById`, `buildRollupRows`, `rollupByCategoryId`, the response mapping) is unchanged — the shape is identical.

- [ ] **Step 4: Run the by-category test**

Run: `cd backend && yarn tsx --import ./test/setup.ts --test src/routes/reporting.test.ts --test-name-pattern 'by-category'`
Expected: PASS.

- [ ] **Step 5: Run the full reporting test file (no regressions)**

Run: `cd backend && yarn tsx --import ./test/setup.ts --test src/routes/reporting.test.ts`
Expected: PASS. The pre-existing direct-only assertions still hold for transactions without accepted links.

- [ ] **Step 6: Typecheck + commit**

Run: `yarn workspace cashflow-backend run typecheck` → no errors.

```bash
git add backend/src/routes/reporting.ts backend/src/routes/reporting.test.ts
git commit -m "feat(reporting): decompose itemized spend in /spending/by-category"
```

> Frontend spend-by-category view: the response contract is unchanged (same `categories[]` shape), so no frontend change is required. Verify visually after deploy; if a "via items" provenance marker is wanted, that is a separate additive follow-up, out of scope here.

---

## Phase 3 — Grow the matchable pool

### Task 7: Populate structured tax/subtotal/shipping + currency in the email parser

**Files:**
- Modify: `backend/src/integrations/parsers/amazon.ts:124-163`
- Test: `backend/src/integrations/parsers/amazonEmailParser.test.ts`

**Interfaces:**
- `parseAmazonReceiptEmail(body: string): ExtractedReceiptOrder | null` — now returns numeric `subtotal`, `tax`, and `currency` (when detectable) on the structured object instead of stuffing them into `notes`.

- [ ] **Step 1: Confirm the `ExtractedReceiptOrder` shape**

Run: `grep -n "subtotal\|tax\|shipping\|currency\|interface ExtractedReceiptOrder\|type ExtractedReceiptOrder" backend/src/ai/extractReceiptItems.ts`. Confirm the field names and types (e.g. `subtotal: number | null`). The steps below assume `subtotal`, `tax`, `currency` exist; adjust names to match.

- [ ] **Step 2: Write the failing test**

```ts
// add to backend/src/integrations/parsers/amazonEmailParser.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAmazonReceiptEmail } from './amazon';

test('populates structured subtotal/tax, not just notes', () => {
  const body = [
    'Order #114-1234567-1234567',
    'Placed on May 21, 2026',
    'Widget',
    'Quantity: 1',
    '$44.97',
    'Order Subtotal: $44.97',
    'Shipping & handling: $0.00',
    'Tax: $5.39',
    'Order Total: $50.36',
  ].join('\n');
  const order = parseAmazonReceiptEmail(body);
  assert.ok(order);
  assert.equal(order!.tax, 5.39);
  assert.equal(order!.subtotal, 44.97);
  assert.equal(order!.total, 50.36);
});
```

Run: `cd backend && yarn tsx --import ./test/setup.ts --test src/integrations/parsers/amazonEmailParser.test.ts --test-name-pattern 'structured'`
Expected: FAIL — `tax`/`subtotal` are null.

- [ ] **Step 3: Populate the fields**

In `parseAmazonReceiptEmail`, the locals `tax` and `shipping` are currently the raw regex string captures dumped into `notesParts`. Parse them and a subtotal, and set the structured fields. Replace lines 139-162 with:

```ts
  const tax = body.match(TAX_RE)?.[1] ?? null;
  const shipping = body.match(SHIPPING_RE)?.[1] ?? null;
  const subtotalMatch = body.match(SUBTOTAL_RE);
  const subtotal = subtotalMatch ? parseAmount(subtotalMatch[1]) : null;
  const currency = detectCurrency(body);

  if (total == null && items.length === 0) return null;

  return {
    vendor: 'amazon',
    vendorName: 'Amazon',
    orderDate,
    orderId,
    subtotal,
    tax: tax != null ? parseAmount(tax) : null,
    total,
    currency,
    paymentLast4: last4,
    tenders: [],
    items,
    notes: orderId ? `Order ${orderId}` : null,
  };
```

Add a `detectCurrency` helper near `parseAmount` (mirror the bookmarklet scraper's currency detection in `frontend/src/bookmarklets/scrape/amazon.ts` — CDN$/US$/£/€; default `null` when ambiguous so downstream currency logic isn't forced):

```ts
function detectCurrency(body: string): string | null {
  if (/CDN\$|CA\$|\bCAD\b/.test(body)) return 'CAD';
  if (/US\$|\bUSD\b/.test(body)) return 'USD';
  if (/£|\bGBP\b/.test(body)) return 'GBP';
  if (/€|\bEUR\b/.test(body)) return 'EUR';
  return null;
}
```

(Note: `SHIPPING_RE`/`shipping` may have no structured destination field on `ExtractedReceiptOrder`. If the type has no `shipping` field, drop the `shipping` local; if it does, set it like `tax`. Confirm in Step 1.)

- [ ] **Step 4: Run the parser tests**

Run: `cd backend && yarn tsx --import ./test/setup.ts --test src/integrations/parsers/amazonEmailParser.test.ts`
Expected: PASS (new + existing). Update any existing test that asserted `tax`/`shipping` appeared in `notes`, since they no longer do — assert the structured fields instead.

- [ ] **Step 5: Verify persistence carries the fields through**

Run: `grep -rn "subtotal\|tax" backend/src/integrations/scanReceipts.ts backend/src/import/vendorCapture.ts | head`. Trace where an `ExtractedReceiptOrder` becomes an `ExternalOrder`. Confirm `subtotal`/`tax` are mapped onto the persisted `ExternalOrder` columns (they exist: `external_orders.subtotal`, `.tax`). If the mapping drops them, add it in the persistence function and add a test there. (`splitTxnByItems` reads `order.tax`/`order.shipping` for extras allocation, so persisting them improves allocation accuracy.)

- [ ] **Step 6: Typecheck + commit**

Run: `yarn workspace cashflow-backend run typecheck` → no errors.

```bash
git add backend/src/integrations/parsers/amazon.ts backend/src/integrations/parsers/amazonEmailParser.test.ts
git commit -m "feat(parser): populate structured tax/subtotal/currency from Amazon emails"
```

---

### Task 8: Harden order_date + last4 extraction and add format coverage

**Files:**
- Modify: `backend/src/integrations/parsers/amazon.ts`
- Test: `backend/src/integrations/parsers/amazonEmailParser.test.ts`

**Rationale:** prod `gmail-scan:ai` orders have 0/103 `last4` and 1/103 `order_date`. With neither, the matcher scores on amount alone and `selectMatchCandidates` rejects the ambiguous result. Extracting date + last4 is what makes email orders matchable.

- [ ] **Step 1: Write failing tests for real-world layouts**

Add fixtures (sanitized, representative) for: a ship-confirm email, a digital (Kindle/Audible) receipt, and a layout where the date reads `Order Date: 2026-06-09` and the card reads `Visa ending in 1234`. Assert `orderDate` and `paymentLast4` are extracted for each.

```ts
test('extracts ISO order date and card last4', () => {
  const body = [
    'Your Amazon.ca order',
    'Order # 701-9999999-0000000',
    'Order Date: 2026-06-09',
    'Payment method: Visa ending in 1234',
    'Item A',
    'Quantity: 1',
    '$10.00',
    'Order Total: $10.00',
  ].join('\n');
  const order = parseAmazonReceiptEmail(body);
  assert.ok(order);
  assert.equal(order!.orderDate, '2026-06-09');
  assert.equal(order!.paymentLast4, '1234');
});
```

Run: `cd backend && yarn tsx --import ./test/setup.ts --test src/integrations/parsers/amazonEmailParser.test.ts --test-name-pattern 'last4|order date'`
Expected: identify which fixtures fail against the current `DATE_RE`/`LAST4_RE`.

- [ ] **Step 2: Broaden the regexes**

Extend `DATE_RE` to also accept `Order Date:` with an ISO date (already partially covered) and common ship-confirm phrasings (`Arriving`, `Shipped on`). Extend `LAST4_RE` beyond `ending in` to include `ending with` and a card-network-prefixed form (`Visa ending in 1234`). Keep the null-on-uncertain bias: do not invent a date/last4 when absent. Show the concrete updated regex literals in the diff.

- [ ] **Step 3: Add digital + refund format handling**

For digital receipts (Audible/Kindle/Prime Video) the item layout differs; ensure `extractItems` still yields at least the title + total. For refund/cancellation emails (subject/body indicates refund), decide the policy: either return `null` (let it not create a spurious order) OR represent it as a negative-total order. **Default: return `null` for refund/cancellation emails** (out-of-scope to model refunds here; documented in the spec). Add a test asserting a refund email returns `null`.

- [ ] **Step 4: Run all parser tests**

Run: `cd backend && yarn tsx --import ./test/setup.ts --test src/integrations/parsers/amazonEmailParser.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/integrations/parsers/amazon.ts backend/src/integrations/parsers/amazonEmailParser.test.ts
git commit -m "feat(parser): harden Amazon email date/last4 + digital/refund handling"
```

---

### Task 9: Matcher recall — tie-break before abstaining

**Files:**
- Modify: `backend/src/amazon/matcher.ts:53-63` (`selectMatchCandidates`)
- Test: `backend/src/amazon/matcher.test.ts`

**Rationale:** 37 of 80 unlinked txns have a plausible amount+date candidate but get no suggestion because `selectMatchCandidates` abstains on a tie at the sub-threshold best score. A date/last4 tiebreak recovers some without reintroducing fan-out.

- [ ] **Step 1: Write the failing test**

```ts
test('selectMatchCandidates breaks a sub-threshold tie by higher date/last4 score when one candidate strictly leads', () => {
  // Two orders tie at amount-only 50, but only one also matches date (+25)→ it
  // should be the sole returned candidate, not an abstain.
  // Construct via scoreAmazonOrderMatch on real Transaction/ExternalOrder builds.
});
```

Implement it concretely against `scoreAmazonOrderMatch` (build a txn + two orders; one shares the date, the other doesn't). Assert exactly one candidate returns.

Run: `cd backend && yarn tsx --import ./test/setup.ts --test src/amazon/matcher.test.ts --test-name-pattern 'tie'`
Expected: FAIL (current code abstains on the amount-only tie).

- [ ] **Step 2: Add the tiebreak**

In `selectMatchCandidates`, before the final `tiedAtBest.length > 1 → []` abstain, if exactly one of the tied candidates has a strictly higher secondary signal, return it. Implement by ranking the tied set on a secondary key only available when the generic `T` carries it — so change `selectMatchCandidates` to accept the already-scored candidates (they carry `confidence`); for the tiebreak, require callers to pass the full scored object including `matchReason` and compare on presence of `'date'`/`'last4'` reason tokens, OR (cleaner) thread a numeric secondary score. **Chosen approach:** keep `selectMatchCandidates` pure on `confidence` but pre-rank ties in `runAmazonMatching` by recomputing a secondary score; if that is too invasive, add an optional `secondary?: number` to the candidate type and break ties on it. Show the final code. Preserve the fan-out guard: if the secondary also ties, abstain.

- [ ] **Step 3: Regression — no new fan-out**

Add/keep a test asserting that two candidates tied on BOTH amount and date+last4 still abstain (return `[]`).

Run: `cd backend && yarn tsx --import ./test/setup.ts --test src/amazon/matcher.test.ts`
Expected: PASS.

- [ ] **Step 4: Typecheck + commit**

Run: `yarn workspace cashflow-backend run typecheck` → no errors.

```bash
git add backend/src/amazon/matcher.ts backend/src/amazon/matcher.test.ts
git commit -m "feat(amazon): tie-break sub-threshold matches by date/last4 to lift recall"
```

---

## Final verification

- [ ] **Run the full backend suite**

Run: `yarn workspace cashflow-backend run test` (or the repo's `yarn test`).
Expected: PASS.

- [ ] **Run the full CI gate locally**

Run: `yarn ci` (typecheck, all tests, both production builds).
Expected: PASS.

- [ ] **Finish the branch**

Push, open a PR, enable auto-merge with a merge commit (per repo policy). Flag in the PR description that this is NOT a primitives-spine change (extends Transaction↔Document link + reuses splitTxnByItems derivation), and that the prod backfill (Task 3) is a manual post-merge step.

---

## Self-review notes

- **Spec coverage:** Phase 1 (accept loop) → Tasks 1–4; Phase 2 (reporting wire + reconciliation invariant) → Tasks 5–6; Phase 3 (email parser tax/subtotal/date/last4/currency/formats + matcher recall) → Tasks 7–9. Spine check + out-of-scope (drilldown, Apple, legacy parser deletion) carried from the spec.
- **Reconciliation invariant:** enforced by `splitTxnByItems`'s existing drift booking (`splitTxnByItems.ts:182`) and asserted in Tasks 5 and 6.
- **No new split machine:** confirmed — `splitTxnByItems` + `loadItemAllocationContext` pre-exist.
- **Type consistency:** `decideAutoAccept` single definition (Task 1); `aggregateSpendByCategoryDecomposed` signature identical between Tasks 5 and 6; `upsertSuggestedOrderLink` return-shape change propagated in Task 2 Step 6.
- **Known soft spots for the implementer:** Task 4 (frontend file location) and Task 9 Step 2 (tiebreak threading) are deliberately left with a located decision rather than invented code, because the exact surface/shape must be confirmed against the file at implementation time.
