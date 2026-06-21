# Receipt item AI categorization

Date: 2026-06-01
Status: Approved (design), pending implementation plan

## Context

The new `/receipts` ledger shows a per-receipt "Where it went" category roll-up
(`rollUpCategories` in `frontend/src/components/receipts/ReceiptsList.tsx`). It
renders only when a receipt's line items carry an `inferredCategory`. Costco
till-receipt PDFs are parsed deterministically
(`backend/src/import/pdf/receipts/costcoTillReceipt.ts` emits every item with
`n: null` → `inferredCategory = null`), so the bar never appears for the receipts
that dominate the page. Gmail receipts already get categorized by their parsers
(`categoriseGoogleItem` / `categoriseAppleItem`); Amazon has its own AI
categorizer (`backend/src/amazon/aiCategorizeAmazonItems.ts`, exposed at
`POST /api/amazon/ne/run`). There is **no** categorizer for non-Amazon receipt
items.

This adds an AI categorization pass for non-Amazon `ExternalOrderItem`s so the
roll-up bar populates. **Backend-only.**

## Scope

**In:**
- A receipt-item AI categorizer (new module), self-contained.
- A receipt category taxonomy constant.
- Auto-categorization wired into the non-Amazon import paths.
- A backfill script for existing uncategorized items.

**Out:**
- No change to the Amazon categorizer (`aiCategorizeAmazonItems.ts`) — left as-is
  to avoid regressing a working path.
- No frontend change (the bar already consumes `inferredCategory`).
- No review/accept UI — categories are applied directly; `categoryOverride`
  already exists for manual correction.
- No `businessUsePercent` inference (groceries are not a business-use surface).

## Approach

A **parallel, self-contained module** rather than generalizing the Amazon path.
It reuses only the already-shared low-level helpers — `openaiJsonWithMeta`
(`backend/src/ai/openaiJson.ts`) and `loadCategoryHints`
(`backend/src/ai/suggestTransaction.ts`) — and carries its own prompt, taxonomy,
parse, and apply. Amazon code is untouched.

## Components

### 1. Categorizer — `backend/src/import/categorizeReceiptItems.ts`

```
categorizeReceiptItemsWithAi(
  args: { householdId: number; orderId?: number | null; itemIds?: number[]; limit?: number },
  opts?: { openaiCaller?: ReceiptOpenAiCaller },
): Promise<ReceiptItemCategorizationResult>
```

- Selects `ExternalOrderItem` rows where `inferredCategory IS NULL`, joined
  (`include`) to an `ExternalOrder` with `vendor != 'amazon'` and matching
  `householdId`; optional narrowing by `orderId` or `itemIds`. Limit defaults to
  50 (cap 200), like the Amazon path.
- Batches items in groups of 20; one model call per batch
  (`openaiJsonWithMeta`, `temperature: 0.1`). Prompt: assign every item a
  category, preferring an exact match from the household category hints, else a
  `RECEIPT_CATEGORIES` fallback, else a concise new label. Returns strict JSON
  `{"items":[{"itemId":number,"category":string,"confidence":0-100,"rationale":string}]}`.
- `parseReceiptItemCategorySuggestions(json, items, preferredCategories)` →
  validated `ReceiptItemCategorySuggestion[]` (drops rows whose `itemId` is not in
  the batch; clamps confidence; normalizes and length-limits the label; falls back to
  `'Other'` when the model returns nothing usable).
- Injectable `openaiCaller` so tests stub the network (same pattern as Amazon).
- Returns `{ suggestions, inputSnapshot, meta, promptVersion }` with
  `promptVersion = 'receipt-item-categorization-v1'`.

```
applyReceiptItemCategorySuggestions(suggestions): Promise<number>
```
- For each suggestion, `ExternalOrderItem.update({ inferredCategory, confidence }, { where: { id } })`.
  Does **not** touch `businessUsePercent` or `categoryOverride`. Returns the count
  of rows updated.

### 2. Taxonomy — `backend/src/import/receiptCategories.ts`

`RECEIPT_CATEGORIES` (string[]): `Groceries, Produce, Dairy, Meat & Seafood,
Bakery, Beverages, Alcohol, Snacks, Household, Personal Care, Health & Pharmacy,
Baby & Kids, Pet, Toys, Electronics, Clothing, Home & Garden, Other`.

### 3. Auto-trigger — `backend/src/routes/externalOrders.ts`

In each non-Amazon import handler (`import-pdf`, `import-text`, `import-image`,
`import-csv`), after the order's items are created, call
`categorizeReceiptItemsWithAi({ householdId, orderId })` then
`applyReceiptItemCategorySuggestions(...)`.

- Wrapped in `try/catch`: on failure, `logger.warn(...)` and continue — the import
  response still succeeds; items stay null (bar hidden) as graceful degradation. A
  categorization error must never fail an import.
- Only runs when items were actually created and the order is non-Amazon. Because
  selection filters on `inferredCategory IS NULL`, already-categorized items
  (Gmail parsers) are skipped automatically.
- Respects the existing demo guard: if the handler already calls
  `rejectDemoAiRequest`, categorization sits behind the same guard; otherwise skip
  categorization for demo households.

### 4. Backfill — `backend/scripts/backfill-receipt-item-categories.ts`

- Finds all non-Amazon `ExternalOrderItem` with `inferredCategory IS NULL`, grouped
  by `householdId` (and chunked by order), runs categorize + apply.
- **Dry-run by default**; `--commit` to write.
- **Refuses `--commit` against local sqlite** — mirrors
  `backend/scripts/backfill-receipt-link-acceptance.ts` (commit `13a1435b`). Runs
  against prod.
- Logs per-household counts and a total; on `--commit`, prints rows updated.

## Data flow

Import (non-Amazon) → items created with `inferredCategory = null` →
`categorizeReceiptItemsWithAi({ orderId })` selects those nulls → batched model
calls → `applyReceiptItemCategorySuggestions` writes `inferredCategory` →
`GET /api/external-orders` returns them → frontend `rollUpCategories` →
"Where it went" bar renders.

## Error handling

- Network/model errors during auto-trigger: caught, logged, import unaffected.
- Backfill: a per-batch failure logs and continues to the next batch; the script
  exits non-zero if any batch failed under `--commit`.
- Model returns a malformed/short row: parser falls back to `'Other'` for that
  item rather than dropping it.

## Testing

- `categorizeReceiptItems.test.ts`:
  - `parseReceiptItemCategorySuggestions`: maps itemId→category; clamps confidence;
    drops unknown itemIds; falls back to `'Other'` on empty/garbage.
  - `categorizeReceiptItemsWithAi` with a stub `openaiCaller`: selects only
    null-category non-Amazon items; batches >20; returns one suggestion per item.
  - `applyReceiptItemCategorySuggestions`: writes `inferredCategory`/`confidence`,
    leaves `businessUsePercent` null.
- Import integration test: feed a small non-Amazon order through the import path
  with a stubbed caller → created items end up categorized; a thrown caller leaves
  items null AND the import still returns success.
- Backfill: dry-run writes nothing; `--commit` against sqlite refuses; `--commit`
  with a stub writes.

## Files

- Create: `backend/src/import/categorizeReceiptItems.ts`
- Create: `backend/src/import/receiptCategories.ts`
- Create: `backend/scripts/backfill-receipt-item-categories.ts`
- Modify: `backend/src/routes/externalOrders.ts` (auto-trigger in import handlers)
- Tests: `backend/src/import/categorizeReceiptItems.test.ts` (+ import integration
  coverage in the existing externalOrders route test if present)
- No frontend files.
