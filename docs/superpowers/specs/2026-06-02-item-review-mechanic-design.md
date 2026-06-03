# Item-Review Mechanic — Design

**Date:** 2026-06-02
**Status:** Approved (design)
**Sub-project:** 1 of 3 in the "item-level categorization shrinks the review queue" effort.

## Problem

The review queue is too long. A major contributor: a transaction linked to an
itemized receipt (Costco, Amazon) is **fully categorized at the item level**, yet
still lands in review.

Root cause: `linkItemsStage.ts` collapses all per-item categories into a single
`Transaction.autoCategory` — `high` confidence only when every item shares one
category, otherwise `medium` (largest-spend item's category). A `medium` /
`source='item-link'` signal never clears review, because
`computeReviewFlag.ts:111` clears only on a high-confidence `rule`/`memory`/`recurring`
category. So a 30-item Costco receipt with every item categorized is forced into a
single category the system can't confidently pick, and gets `reviewFlag=true`.

The item-level data and UI already exist (`external_order_items` carries
`inferred_category`, `category_override`, `business_use_override`, `confidence`;
`ReceiptItemsDrawer`, `ItemDetailDrawer`, `/items` page). What's missing is a rule
that treats a fully-categorized itemized transaction as *done*, and a review UI
that surfaces only the un-categorized stragglers.

## Goal & non-goals

**Goal:** A transaction whose linked receipt items are all categorized (high-conf
AI or user-overridden) drops out of the review queue. When some items are
stragglers, the review inbox surfaces those items inline so they can be fixed in
place, after which the transaction clears.

**Non-goals (this cut):**
- No budget/category split. The transaction stays one row with one rollup
  `final_category` (Model A). Per-category dollar allocation (`splitTxnByItems.ts`)
  is **not** wired into budgets/reports here.
- No new receipt-source parsing. Works on data we already itemize (Costco, Amazon).
  Email vendors (sub-project 2) and generic attach→extract (sub-project 3) are
  separate specs.
- No cross-transaction "all stragglers" pooled lane. Per-transaction expand only.

## Design decisions (settled during brainstorming)

- **End state for a multi-category receipt:** Model A — stays one transaction,
  items hold per-category truth, transaction auto-clears when every item is
  categorized. No split.
- **Clear bar:** conservative — clear only when every item is high-confidence AI
  **or** user-overridden. Low-confidence items keep the transaction in review.
- **`reviewFlag` stays the single authoritative column.** No separate derived
  "effective review" state. All existing readers (dashboard, review query,
  bulk-patch) work unchanged.

## Architecture

### Per-item bar

An item "counts as done" when:

```
category_override != null                                  // user touched → counts
  OR (inferred_category != null AND confidence >= THRESHOLD)  // high-conf AI
```

- `THRESHOLD` = env `ENRICHMENT_ITEM_CLEAR_CONFIDENCE`, default `80`, on the
  existing `external_order_items.confidence` scale (DECIMAL 0–100). Follows the
  existing `enrichmentAi*` config pattern in `backend/src/config/env.ts`.
- `confidence` null → treated as below threshold (straggler).

Pure function:

```ts
// backend/src/import/enrichment/transactionClearsFromItems.ts
export type ItemClearInput = {
  inferredCategory: string | null;
  categoryOverride: string | null;
  confidence: number | null;
};
export function itemMeetsBar(item: ItemClearInput, threshold: number): boolean;
export function transactionClearsFromItems(items: ItemClearInput[], threshold: number): boolean;
// transactionClearsFromItems: items.length > 0 && items.every(i => itemMeetsBar(i, threshold))
```

### Per-transaction clear

`reviewFlag` becomes `false` when **either**:

1. the existing `computeReviewFlag` condition holds (rule/memory/recurring
   high-confidence category — **unchanged**), **or**
2. the transaction has ≥1 *accepted* `TransactionOrderLink`, those linked orders
   have ≥1 item in total, and `transactionClearsFromItems(allItems)` is true.

A linked order that parsed to zero items does **not** trigger item-clear → falls
back to normal logic.

This is an **OR layered on top** of existing logic, not a replacement.
Non-itemized transactions are entirely unaffected.

**Baseline is re-derived statelessly, never read from the column we overwrite.**
The non-item review baseline = `mergeSignals(persistedSignals).fields.reviewFlag`,
where `persistedSignals` are the transaction's `TransactionSignal` rows. Import
persists the full signal array per transaction (`runImport.ts:493`,
`commitStatementImport.ts:402`, `runEnrichmentBackfill.ts:362`,
plus the AI signal at `aiBatchOverColdRows.ts:147`), so the baseline is always
reconstructable. Effective flag:

```
effectiveReviewFlag = baseline && !transactionClearsFromItems(items)
```

Re-deriving the baseline each time (rather than caching it in a column) is what
makes override-removal correct: when a user clears an override and an item drops
below the bar, recompute recomputes `baseline` from the unchanged signals, finds
`itemClear=false`, and the transaction correctly re-enters review. No baseline
column is needed.

### Recompute function

```ts
// backend/src/import/enrichment/recomputeTransactionReviewFromItems.ts
export async function recomputeTransactionReviewFromItems(txnId: number): Promise<void>;
```

- Loads the transaction, its persisted `TransactionSignal` rows, its accepted
  linked orders, and all their items.
- `baseline = mergeSignals(signals).fields.reviewFlag`;
  `effectiveReviewFlag = baseline && !transactionClearsFromItems(items)`.
- Recomputes `importConfidence` via `computeImportConfidence` (same inputs
  `persistAiEnhancement` already uses).
- Writes back `reviewFlag` + `importConfidence` + `importConfidenceFlags`.
- **Best-effort:** wrapped in try/catch, logs `recompute_review_from_items_failed`
  on error, leaves the row untouched. An item edit never fails because recompute
  threw. Mirrors `persistAiEnhancement` (aiBatchOverColdRows.ts:159).

### Recompute triggers

Every point item-state changes calls `recomputeTransactionReviewFromItems` for the
affected transaction(s). Because `TransactionOrderLink` is many-to-many, "affected
transactions" = all transactions with an accepted link to the changed order;
recompute each **once** (dedupe txnIds).

| Trigger | Site |
|---|---|
| Costco item categorization completes | `categorizeAndApplyReceiptItems` (`categorizeReceiptItems.ts`) |
| Amazon item categorization completes | `POST /api/external-orders/:id/categorize-items` |
| Item override patched | `PATCH /api/external-order-items/:id` (`receipts.ts`) |
| Item bulk override | `POST /api/external-order-items/bulk-patch` (`items.ts`) |
| Order linked / link accepted / rejected / unlinked | match + link mutation sites (`matchReceiptToTransactions.ts`, link status routes) |
| Receipt analyzed → items created | `POST /receipts/:id/analyze` |

Categorization that processes a batch recomputes affected transactions **once each
after the batch**, not per item.

### Display (Model A preserved)

Transaction stays one row. `final_category` keeps today's rollup behavior
(all-same → that category; mixed → largest-spend item). No change to
`linkItemsStage.ts` rollup logic. Optional "mixed/itemized" visual indicator is a
frontend concern (below), not a data change.

## Frontend — item-aware review inbox

### List payload

`GET /api/transactions?reviewFlag=true` adds per itemized row:

```ts
itemized: { itemCount: number; stragglerCount: number } | null
```

- `stragglerCount` = items failing the per-item bar.
- Computed with COUNT queries joined through accepted `TransactionOrderLink` →
  `external_order_items`. No item rows shipped in the list response.
- Non-itemized rows: `itemized: null` — render exactly as today.

### Row badge

Itemized rows show `🧾 {itemCount} items · {stragglerCount} need review`. The badge
is the signal "this row is here because of stragglers." A row with
`stragglerCount === 0` should not normally appear (it would have cleared), but if
it does (race), the badge reads `🧾 {itemCount} items`.

### Expand-in-row

Click the badge → inline expandable item list under the row. Lazy-loads order
items on first expand (existing order-items GET). Reuses the existing `ItemRow`
component (category `<select>` + business override) from `ReceiptItemsDrawer` — no
new editing component. **Stragglers sorted to top and amber-marked**; done items
muted/collapsed below.

Chosen over reusing the full `ReceiptItemsDrawer` slide-over so the reviewer stays
in the list and never loses queue context.

### Fix-in-place → row leaves

Editing a straggler's category calls `PATCH /api/external-order-items/:id` →
backend recompute fires → response carries the transaction's new `reviewFlag`. If
it flipped to false, the row animates out of the inbox. Optimistic update;
reconcile on response.

### Non-itemized flow untouched

Bulk-select + `bulk-patch` stays for plain merchant transactions.

## Backfill

Existing already-itemized transactions won't auto-clear until something triggers
recompute. A one-time sweep — reusing the `enrichmentBackfill` job pattern
(`backend/src/jobs/definitions/enrichmentBackfill.ts`) — calls
`recomputeTransactionReviewFromItems` for every transaction with an accepted
itemized link. Idempotent, re-runnable, manual-trigger + included in the nightly
backfill. This is what shrinks the **current** queue.

## Testing

**Unit — `transactionClearsFromItems` / `itemMeetsBar`:**
- all items high-confidence → clears
- one low-confidence straggler → does not clear
- `category_override` non-null counts even with low/null confidence
- zero items → does not clear (falls back to normal logic)
- `confidence` null → straggler

**Unit — `recomputeTransactionReviewFromItems`:**
- writes `reviewFlag` + `importConfidence` consistent with `computeImportConfidence`
- OR's correctly with existing non-item review state (rule/memory high-conf stays cleared even if items are stragglers)
- best-effort: throws inside → logs, leaves row unchanged

**Integration:**
- `PATCH` straggler category → `reviewFlag` flips to false
- removing an override that drops an item below bar → `reviewFlag` flips back to true
- order unlink / reject → reverts to normal review logic
- transaction with two linked orders → clears only when items across **both** pass
- one order linked to two transactions → both recomputed
- backfill sweep idempotent (second run is a no-op)

**Frontend:**
- itemized row renders the badge with correct counts
- expand lazy-loads items, stragglers sorted to top
- fixing the last straggler removes the row from the inbox

## Files

**New:**
- `backend/src/import/enrichment/transactionClearsFromItems.ts`
- `backend/src/import/enrichment/recomputeTransactionReviewFromItems.ts`
- backfill job definition (or extend `enrichmentBackfill`)
- frontend: inline item-expand within `ReviewInboxPage` (reusing `ItemRow`)

**Modified:**
- `backend/src/config/env.ts` — `ENRICHMENT_ITEM_CLEAR_CONFIDENCE`
- `backend/src/import/categorizeReceiptItems.ts` — recompute after batch
- `backend/src/routes/externalOrders.ts` — recompute after Amazon categorize
- `backend/src/routes/receipts.ts` — recompute after `PATCH /external-order-items/:id` and `/receipts/:id/analyze`
- `backend/src/routes/items.ts` — recompute after item bulk-patch
- `backend/src/import/matchReceiptToTransactions.ts` + link-status routes — recompute on link/unlink
- `backend/src/routes/transactions.ts` — add `itemized` summary to list payload
- `frontend/src/pages/ReviewInboxPage.tsx` — badge + expand-in-row

**Unchanged on purpose:** `computeReviewFlag.ts` (item-clear is layered as an OR in
the recompute path, not a rewrite of the per-row merge), `linkItemsStage.ts` rollup.

## Open follow-ups (later sub-projects)

- **Sub-project 2:** verify Apple/Google/Uber email items carry category + confidence so they flow through this mechanic.
- **Sub-project 3:** generic attach→extract→itemize for any transaction (statement line, manual entry).
- Cross-transaction "all stragglers" pooled review lane.
