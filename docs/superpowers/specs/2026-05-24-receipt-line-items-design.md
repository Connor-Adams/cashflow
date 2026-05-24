# Receipt Line Items — First-Class Viewing & Per-Item Categorization

**Status:** Draft
**Date:** 2026-05-24
**Goal:** Let users see and recategorize every line item from a receipt, so dashboard/budget reports reflect exactly where each dollar of a transaction went.

## Background

Two parallel receipt-processing paths exist on `main`:

1. **File-attached path** — `POST /api/transactions/:tid/receipts` uploads a file. `POST /api/receipts/:id/analyze` runs `backend/src/ai/receiptVision.ts`, which extracts only `{merchant, total, currency, date, summary}` and writes the JSON to `Receipt.extractedNote`. **No line items.**
2. **Import path** — `POST /api/external-orders/import-{text,image,csv,pdf}` runs `backend/src/ai/extractReceiptItems.ts`, which extracts full `{vendor, items[], tenders[], subtotal, tax, total, paymentLast4, ...}` and persists into `external_orders` + `external_order_items` + `external_order_tenders`. `TransactionOrderLink` provides M:N between Transaction and ExternalOrder with `linkedAmount` per link (split-tender support already wired).

The structured data model exists. The UI does not surface it. File-attached receipts never get items extracted at all.

## Goals

- View every line item from a receipt, in context of its transaction.
- Override per-item category; reports and budgets reflect overrides.
- Unify the two vision pipelines so any receipt — file-attached, email-imported, CSV, PDF — produces structured items.
- Preserve existing behavior for transactions without receipts.

## Non-Goals (v1)

- Cross-receipt items browser page ("find all coffee purchases this year"). Planned as a follow-up once drill-down works.
- Manual non-receipt transaction splits ("split this $100 into $60 groceries + $40 misc by hand").
- Auto-backfill script across all existing receipts. Per-receipt opt-in via "Extract items" button only.
- Receipt deletion cascading to ExternalOrders.

## Architecture

```
Receipt (file blob)  ──── attachedTo ────▶  Transaction
        │
        │ externalOrderId (NEW FK, nullable)
        ▼
ExternalOrder ─── 1:N ───▶ ExternalOrderItem (+ categoryOverride NEW, + businessUseOverride NEW)
        │                                │
        │ 1:N tenders                    │
        ▼                                │
ExternalOrderTender                      │
        │                                │
        │ M:N via TransactionOrderLink  │ effectiveCategory(item) =
        │ (existing, with linkedAmount) │   coalesce(categoryOverride,
        ▼                                │            inferredCategory,
Transaction ◀────────────────────────────┘            txn.category)
```

Three new things on top of the existing model:

1. **`receipts.external_order_id`** (nullable FK) — bridges file-attached Receipt to its structured ExternalOrder.
2. **`external_order_items.category_override`** + **`business_use_override`** — preserve OCR-inferred values, layer user intent on top.
3. **`splitTxnByItems(txn, links, ordersById, itemsByOrder) → CategoryAllocation[]`** — pure function consumed by dashboard, monthly, and budget aggregators.

Vision pipelines unify: `POST /api/receipts/:id/analyze` switches from `analyzeReceiptFile` (items-blind) to `extractReceiptFromImage` + `persistExtractedOrder`. The result is linked back via `Receipt.externalOrderId`. New receipts get items by default; existing receipts opt in via a per-receipt "Extract items" button that calls the same endpoint.

## Components

### Backend

| File | Change |
| ---- | ------ |
| `backend/src/migrations/20260524000001-receipt-item-overrides.js` | NEW. Adds `receipts.external_order_id` (INT, nullable, FK `external_orders.id`, `ON DELETE SET NULL`). Adds `external_order_items.category_override` (STRING(128), nullable) and `business_use_override` (DECIMAL(5,2), nullable). |
| `backend/src/models/Receipt.ts` | Declare + init `externalOrderId`. |
| `backend/src/models/ExternalOrderItem.ts` | Declare + init `categoryOverride`, `businessUseOverride`. |
| `backend/src/models/index.ts` | `Receipt.belongsTo(ExternalOrder, {as:'externalOrder', foreignKey:'externalOrderId'})`; `ExternalOrder.hasMany(Receipt, {as:'receipts', foreignKey:'externalOrderId'})`. |
| `backend/src/import/splitTxnByItems.ts` | NEW. Pure function. See "Algorithm" below. |
| `backend/src/summary/aggregateDashboard.ts` | Replace per-txn category attribution with `splitTxnByItems(...)` loop. |
| `backend/src/summary/aggregateMonthly.ts` | Same. |
| `backend/src/routes/budgets.ts` — `aggregateSpendByCategory` | Replace `row.finalCategory` summation with iteration over `splitTxnByItems(txn, ...)` allocations. Pure function; existing tests in `aggregateSpendByCategory.test.ts` extended to cover items. |
| `backend/src/routes/receipts.ts` | `POST /api/receipts/:id/analyze` switches to `extractReceiptFromImage` + `persistExtractedOrder`. Sets `receipt.externalOrderId`. Response keeps existing summary fields (`extracted.merchant/total/...`) and adds `extracted.items[]`. |
| `backend/src/routes/receipts.ts` | NEW `PATCH /api/external-order-items/:id` accepting `{categoryOverride?, businessUseOverride?}`. Auth walks `item → order → TransactionOrderLink[] → Transaction.householdId`; at least one link must be in the caller's household. |
| `backend/src/routes/receipts.ts` | `GET /api/transactions/:tid/receipts` extended to include each receipt's `externalOrderId`, `order:{subtotal,tax,shipping,total,currency,vendor}`, and `items[]`. |
| `shared/api-types.ts` | Extend `Receipt` response with `externalOrderId`, `order`, `items: ExternalOrderItemView[]`. |

### Frontend

| File | Change |
| ---- | ------ |
| `frontend/src/pages/TransactionsPage.tsx` | When `receiptCount > 0`, render a "View items" button alongside the existing receipt badge. Opens drawer. |
| `frontend/src/components/ReceiptItemsDrawer.tsx` | NEW. One panel per attached receipt: vendor header, items table (title, qty, unitPrice, totalPrice, category dropdown, business-use input), then Subtotal / Tax / Shipping / Total rows. (Tip not modeled — `ExternalOrder` has no tip column today; deferred until a receipt format that exposes one is added.) Category dropdown reuses existing `category-hints`. Save-on-blur PATCHes `/api/external-order-items/:id`. |
| `frontend/src/components/ReceiptItemsDrawer.tsx` | Per-receipt "Extract items" button when `externalOrderId == null`. Calls `POST /api/receipts/:id/analyze`. Loading + error states per receipt. |

## Algorithm: `splitTxnByItems`

```ts
type CategoryAllocation = {
  category: string | null;
  amount: number;          // signed, matches txn.amount sign
  businessAmount: number;  // amount * businessUsePercent/100
  currency: string;
};

function splitTxnByItems(
  txn: Transaction,
  links: TransactionOrderLink[],          // for this txn
  ordersById: Map<number, ExternalOrder>,
  itemsByOrder: Map<number, ExternalOrderItem[]>,
): CategoryAllocation[];
```

**Rules:**

1. If `links.length === 0` or no order has items → return single allocation `{category: txn.category, amount: txn.amount, businessAmount: txn.businessAmount ?? 0, currency: txn.currency}`. This preserves existing behavior for txns without receipts.
2. For each link, compute the per-link share: `share = linkedAmount / order.total` (default 1 when both null). Items scale by `share`.
3. For each item in the order:
   - `effectiveCategory = item.categoryOverride ?? item.inferredCategory ?? txn.category`
   - `effectiveBusinessUse = item.businessUseOverride ?? item.businessUsePercent ?? 0`
   - `itemBase = item.totalPrice ?? (item.unitPrice * item.quantity) ?? 0` (scaled by `share`)
4. Pro-rate `(tax + shipping)` (each from `order`, scaled by `share`) across items by `itemBase / sum(itemBase)` weight.
5. Sign: multiply final per-allocation amount by `sign(txn.amount)` to keep debit/credit conventions intact.
6. **Drift handling**: if `sum(allocations) !== |txn.amount| × sign`, lump the remainder into a synthetic `{category: txn.category, amount: remainder}` bucket. Log at info level with `{txnId, expected, computed, drift}`.
7. **Currency**: prefer `txn.currency` for output. Warn if `order.currency !== txn.currency`.

## Data Flow

### Upload a new receipt

```
User picks file in TransactionsPage
  → POST /api/transactions/:tid/receipts (multipart)
  → receiptStorage writes blob, Receipt row (externalOrderId=null)
  → no auto-analyze (unchanged)

User clicks "Extract items"
  → POST /api/receipts/:id/analyze
  → extractReceiptFromImage(dataUrl) → ExtractedReceiptOrder
  → persistExtractedOrder → ExternalOrder + items + tenders (or hit existing dedupe)
  → matchReceiptOrderToTransactions → TransactionOrderLink rows (M:N via tenders)
  → Receipt.update({externalOrderId, extractedNote: JSON.stringify(extracted)})
  → response: { receipt, order, items, links }
```

### View items on a transaction

```
GET /api/transactions/:tid/receipts
  → per-receipt payload includes externalOrderId, order summary, items[]
  → ReceiptItemsDrawer renders one panel per receipt
```

### Override an item category

```
User picks category in dropdown → blur
  → PATCH /api/external-order-items/:id {categoryOverride: "Household"}
  → auth check: at least one linked txn in caller's household, else 404
  → item.update; respond with updated item
  → frontend updates optimistically, reverts on error
```

### Reports/budgets aggregation

```
For each txn in range:
  allocations = splitTxnByItems(txn, links, ordersById, itemsByOrder)
  for each allocation:
    bucket[allocation.category] += allocation.amount
```

Batch-load `TransactionOrderLink`, `ExternalOrder`, `ExternalOrderItem` for the txn set in one query each; build the lookup maps once per request.

### Backfill existing receipts

No global script. Each receipt's "Extract items" button reuses the analyze endpoint. User-paced OpenAI cost.

## Error Handling

**Vision extraction failures (`extractReceiptFromImage`):**
- 503 (no OpenAI key) — toast in drawer; button disabled with hint.
- 429 (rate limited) — toast "Try again in a moment"; drawer state preserved.
- 502 (OpenAI 5xx) — toast with retry button.
- 422 (extractor returned empty items + total) — inline "OCR couldn't read this receipt"; receipt stays summary-only.

**`persistExtractedOrder` dedupe collision:**
- Existing dedupeKey (vendor + orderId + date + total + itemCount). Re-running analyze on the same receipt finds the existing order via `findOrCreate`; `Receipt.externalOrderId` re-points to it. No duplicate items.

**Item-override authorization:**
- `PATCH /api/external-order-items/:id` returns 404 (not 403) on cross-household access to avoid id-enumeration.
- `categoryOverride`: accept any non-empty string (mirrors existing `Transaction.category` looseness). Reject `""` with 400.
- `businessUseOverride`: must be in `[0, 100]`. 400 otherwise.

**Aggregator robustness (`splitTxnByItems`):**
- No items → single fallback allocation = txn.category, txn.amount.
- All `totalPrice` null → even split by item count; if `items.length === 0`, single fallback bucket.
- Drift between sum(allocations) and |txn.amount| → remainder bucket at txn.category; logged.
- Currency mismatch → warn, use txn.currency.

**Concurrent overrides:** Last-write-wins via PATCH. No optimistic locking in v1.

**Receipt deletion cascade:** Existing `DELETE /api/receipts/:id` removes the file + row. `external_orders` row is **not** cascade-deleted; FK is `ON DELETE SET NULL` on `receipts.external_order_id`. Other receipts and txn links to the order survive.

**Migration safety:** All new columns are nullable with no row-touching defaults. Aggregator's no-op fallback when items are missing means: migration first, aggregator change second, frontend third — each step is independently deployable and reversible.

## Testing

**Unit — `splitTxnByItems`** (`backend/test/splitTxnByItems.test.ts`):
- No links/items → single bucket = txn.category, amount = txn.amount.
- One link, items with totalPrice + tax → pro-rated tax by weight; `sum(allocations) ≈ |txn.amount|`.
- `categoryOverride` wins over `inferredCategory` wins over `txn.category`.
- Items with null totalPrice excluded from weighting; remainder bucket gets txn.category.
- Multi-tender: `linkedAmount=$60` of `$100` order → allocations sum to $60.
- Sum drift (items=$95, total=$100) → $5 unallocated → txn.category bucket, log emitted.
- Currency mismatch warning path.

**Unit — model + migration:**
- Migration up + down, columns + FK present/absent.
- `Receipt.externalOrder` association resolves.

**Integration — receipt analyze switch** (`backend/test/integration/receiptAnalyzeItems.test.ts`):
- Mock OpenAI returning ExtractedReceiptOrder with 3 items.
- `POST /api/receipts/:id/analyze` → ExternalOrder + 3 items + tenders persisted, `Receipt.externalOrderId` set, `TransactionOrderLink` created when txn matches.
- Re-run on same receipt → dedupe via dedupeKey, no duplicate items.
- 503 path (no OpenAI key) → 503 response, Receipt unchanged.
- Cross-household: POST to receipt outside caller's household → 404.

**Integration — PATCH override** (`backend/test/integration/itemOverride.test.ts`):
- Cross-household → 404.
- Valid PATCH updates `categoryOverride`.
- `businessUseOverride` out of range → 400.

**Integration — aggregator end-to-end** (`backend/test/integration/dashboardWithItems.test.ts`):
- Seed: $100 Costco txn linked to order with 2 items ($60 Groceries inferred, $40 Household override), tax $5.
- `GET /api/summary/dashboard` → Groceries=$63 (60 + 60/100×5), Household=$42 (40 + 40/100×5).
- Same txn without items → categoryReports has `txn.category=$100`.
- Multi-tender: order linked to two txns ($60 + $40 via tenders) → each txn's allocations scale by linkedAmount.

**Integration — receipts GET extended** (`backend/test/integration/transactionReceiptsWithItems.test.ts`):
- `GET /api/transactions/:tid/receipts` returns `items` for receipts with `externalOrderId`; empty `items` otherwise.

**Frontend — drawer** (`frontend/src/components/ReceiptItemsDrawer.test.tsx`):
- Renders item rows with title/qty/totalPrice.
- Subtotal/Tax/Shipping/Total rows present, formatted correctly.
- Category dropdown change triggers PATCH; row reflects new value.
- "Extract items" button visible iff `externalOrderId == null`.
- Loading state during analyze; error state on 502/429.

**Manual verification:**
- Real Costco till PDF flow still works end-to-end (no regression).
- Real Amazon email import still works.
- Upload an image receipt → click "Extract items" → see items → override category → dashboard reflects override.

## Rollout Order

1. Migration only (additive columns, nullable, FK with `ON DELETE SET NULL`). Safe on its own.
2. Backend: models, `splitTxnByItems`, aggregator updates, route changes, PATCH endpoint. Aggregator is a no-op for txns without items.
3. Frontend: `ReceiptItemsDrawer`, "View items" entry point, "Extract items" per-receipt button.
4. (Out of scope) Cross-receipt items browser page in a follow-up.

Each step is independently deployable and reversible.
