# Receipt Items Tab — Design

**Date:** 2026-05-24
**Status:** Approved, awaiting implementation plan
**Supersedes:** N/A
**Builds on:** [2026-05-24-receipt-line-items-design.md](2026-05-24-receipt-line-items-design.md), shipped as [PR #126](https://github.com/Connor-Adams/cashflow/pull/126)

## Goal

Make receipt line items a first-class object in the UI. Today items are reachable only through a per-transaction drawer (`ReceiptItemsDrawer`). A dedicated `Items` tab — browseable, analyzable, and searchable across every receipt — turns "track exactly where every dollar goes" into a workflow rather than a per-receipt chore.

## Out of scope

- Items synthesized from transactions without receipts. Items tab only surfaces `ExternalOrderItem` records.
- Server-driven group-by (grouping is client-side post-fetch over a stable, ungrouped server sort).
- A new chart library — uses existing `recharts`.
- A query-cache library (TanStack, SWR) — uses existing custom `useEffect + getJson` hook pattern.

## Scope (full dashboard)

Three subtabs inside `/items`:

1. **Browse** — grouped-by-receipt table (default; toggle to category or flat), filter chips, multi-select bulk-edit toolbar, infinite scroll.
2. **Analyze** — KPI strip + trend chart + top-items bar + collapsible heatmap with drill (PR-B).
3. **Search** — free-text search + filter chips + flat results table + CSV export of filtered results.

## Architecture

### Route + nav

- New route `/items` registered in the existing React Router config.
- Sidebar entry between `/transactions` and `/import` (label `Items`, icon `Package` from `lucide-react`). Edit at [Sidebar.tsx:42](frontend/src/components/Sidebar.tsx:42).
- Subtab + filter state URL-synced via `useSearchParams`:
  `?tab=browse|analyze|search&category=&businessUse=&from=&to=&vendor=&minPrice=&maxPrice=&q=&item=`
- Browse and Search share the same filter set. Analyze reads only `category`, `businessUse`, `vendor`, `from`, `to`.

### Page shell

`frontend/src/pages/ItemsPage.tsx` owns:

- Subtab state (`useSearchParams` → `tab`).
- Shared filter state (one `useItemsFilters()` hook → reads/writes URL params).
- Drawer state (`useSearchParams` → `item`).

Renders sticky page header (title + `Tabs` primitive) and the active subtab. Filter chip strip mounts above Browse and Search bodies; Analyze renders its own date+category+vendor chip set (subset).

### Subtab components

| File | Purpose | Phase |
|---|---|---|
| `frontend/src/components/items/ItemsBrowse.tsx` | Grouped-by-receipt list (default), group-by toggle (`receipt`/`category`/`none`), multi-select toolbar, infinite scroll | PR-A |
| `frontend/src/components/items/ItemsSearch.tsx` | Debounced search input, flat results, CSV export | PR-A |
| `frontend/src/components/items/ItemsAnalyze.tsx` | KPI strip, trend + top-items + collapsible heatmap | PR-B |
| `frontend/src/components/items/ItemDetailDrawer.tsx` | Right-side drawer: details, inline category/business-use edit, allocation breakdown | PR-A |
| `frontend/src/components/items/ItemsFilterStrip.tsx` | 5 chips (category, businessUse, date, vendor, price range) | PR-A |
| `frontend/src/hooks/useItems.ts` | `useItemsQuery`, `useItemsAnalytics`, `useItemAllocation` | PR-A/B |

### Backend

`backend/src/routes/items.ts` (new file, both phases live here):

- **`GET /api/items`** (PR-A) — cursor-paginated, filterable list.
  - Query: `cursor`, `limit` (default 50, max 100), `category`, `businessUse`, `from`, `to`, `vendor`, `minPrice`, `maxPrice`, `q`, `format` (`json`|`csv`).
  - Joins: `ExternalOrderItem` ⨝ `ExternalOrder` ⨝ `Receipt` ⨝ `Transaction`.
  - Scope: filter via existing `visibleTransactionWhere` helper.
  - Sort: `receipt.date DESC, order.id DESC, item.id ASC` (stable).
  - Cursor: base64-encoded `{ receiptDate, orderId, itemId, filterHash }`. Filter mismatch → 400.
  - Returns `{ items: ItemRow[], nextCursor: string|null }`.
- **`PATCH /api/external-order-items/bulk`** (PR-A) — body `{ itemIds: number[], categoryOverride?, businessUseOverride? }`. Transactional. Cap 200 ids.
- **`GET /api/items/:id/allocation`** (PR-A) — returns `{ itemTotal, taxShare, shippingShare, allocatedTotal, categoryBucket, txnId, txnAmount, percentOfTxn, linkedTxnIds }`. Reuses `splitTxnByItems` from [backend/src/import/splitTxnByItems.ts](backend/src/import/splitTxnByItems.ts).
- **`GET /api/items/analytics`** (PR-B) — same filters minus `q`/`minPrice`/`maxPrice`. Returns `{ kpis, trend, topItems, heatmap }` precomputed server-side. Date-range cap 2 years. `Cache-Control: private, max-age=60`.

Existing `PATCH /api/external-order-items/:id` ([receipts.ts:307](backend/src/routes/receipts.ts:307)) reused unchanged for per-item drawer edits.

Router registered alongside existing routes (verify mount point — likely `backend/src/app.ts`).

### ItemRow shape

```ts
type ItemRow = {
  id: number
  title: string
  qty: number
  unitPrice: number
  totalPrice: number
  taxShare: number              // pro-rated tax allocation
  categoryEffective: string     // override if present, else inferred
  categoryOverride: string | null
  businessUseEffective: boolean
  businessUseOverride: boolean | null
  order: { id: number; vendor: string }
  receipt: { id: number; date: string; sourceTxnId: number | null }
}
```

## Data flow

**Browse load:**
1. `ItemsPage` reads URL → derives filters + tab + groupBy.
2. `useItemsQuery(filters, cursor=null)` → `GET /api/items?...&limit=50`.
3. Server joins, filters, sorts, returns `{ items, nextCursor }`.
4. Client groups by receipt (or category, or none) post-fetch. Group headers render on key change.
5. IntersectionObserver sentinel → `fetchMore(nextCursor)` appends rows.

**Filter change:**
- Filter state write → cursor dropped → list cleared → refetch. `cancelled` flag discards in-flight stale response (same pattern as [useAiInboxCount.ts:23](frontend/src/hooks/useAiInboxCount.ts:23)).

**Search:**
- `ItemsSearch` adds debounced `q` (300ms) and writes to URL on debounce fire. Same endpoint as Browse.
- Export: builds URL with `format=csv`, opens via `window.open`. Backend streams CSV.

**Per-item edit:**
- Drawer inline editor → `PATCH /api/external-order-items/:id`. Optimistic local update on 200.

**Bulk edit:**
- Toolbar → `PATCH /api/external-order-items/bulk`. Transactional. Optimistic update on 200. Selection cleared on success; preserved on failure.

**Allocation breakdown:**
- Drawer mount → `GET /api/items/:id/allocation`. Reuses `splitTxnByItems`.

**Analytics (PR-B):**
- `GET /api/items/analytics?...` → precomputed JSON. No client-side aggregation.
- Per-chart skeleton while loading.

### Performance guardrails

- Browse page size 50; infinite scroll triggers ≈300px from bottom.
- Analytics date range cap 2 years (server-side). UI warns when exceeded.
- CSV streams row-by-row. Hard cap 50k rows → 413 on overflow.

## Error handling & edge cases

| Scenario | Behavior |
|---|---|
| Fetch error | Inline banner inside subtab body with retry. Chrome stays interactive. Items list must not lie — no silent fallback to empty. |
| No items at all | Empty illustration + CTA linking to Transactions/Import. |
| No items match filters | "0 items match · [Clear filters]" with chip strip visible. |
| Search 0 results | "No items match '<q>'. Try removing filters or shortening the query." |
| 401 | Existing global auth handler → redirect to `/auth`. |
| 403 on edit | Toast "You can't edit this item" + close drawer. |
| Bulk edit any-row failure | Backend transactional → all or nothing. Toast + preserve selection. |
| `itemIds.length > 200` | Toolbar disabled with hint above 200; backend 400 as safety. |
| Filter change mid-fetch | `cancelled` flag discards stale response. |
| Tab switch mid-fetch | Unmount aborts subtab's `useItemsQuery`. |
| Cursor + filter mismatch | Backend 400. Client drops cursor on filter change so this is defensive. |
| CSV export empty | 204 + toast "Nothing to export with current filters". |
| CSV >50k rows | 413 + toast "Result set too large (>50k items). Narrow your filters." |
| Item linked to multiple txns | Drawer shows dominant link + `[view all]` expanding linked txn list. |
| Item not linked | "Not linked to a transaction yet — [link from Amazon/Import]". No allocation math. |
| Stale `suggested` TransactionOrderLink rows | Already cleaned at analyze endpoint (fixed in [PR #126](https://github.com/Connor-Adams/cashflow/pull/126)). Drawer trusts current link set. |

**Loading states:**
- First load: 8-row skeleton. Chrome renders immediately.
- Pagination: shimmer at bottom while next page loads.
- Drawer: spinner in body until allocation fetch settles.
- Analyze: per-chart skeleton (KPI strip, trend, top-items independent).

**Accessibility:**
- `Tabs` primitive provides arrow-key nav + aria-selected ([tabs.tsx:48](frontend/src/components/ui/tabs.tsx:48)).
- Drawer: focus trap, restore focus to triggering row on close, Esc closes.
- Multi-select rows: checkbox column with aria-label; Shift-click range select.
- Filter chips: each is a `<button>` with `aria-expanded` controlling its popover.
- Tables: `<th scope="col">` headers; group headers `<th scope="rowgroup">`.

**Logging:**
- Backend: slow query log >500ms with `q` redacted (use existing logger).
- Frontend: `clientLogs` event on export failure and bulk-edit failure (existing [clientLogs.ts](backend/src/routes/clientLogs.ts) route).

## Testing

### Backend (Vitest)

`backend/src/routes/items.test.ts` (new, PR-A):

- `GET /api/items` happy path returns enriched rows.
- Each filter (category, businessUse, vendor substring, from/to inclusive, price range inclusive, `q` case-insensitive).
- Cursor pagination: 3 pages of 50, no overlap, no skip.
- Sort stability on identical `receipt.date`.
- Auth scope isolation (user A cannot see user B items).
- Override columns surface in `categoryEffective` / `businessUseEffective`.
- CSV format: correct headers, escapes commas/quotes/newlines.
- Empty result → `{ items: [], nextCursor: null }`.
- Cursor + filter mismatch → 400.

`PATCH /api/external-order-items/bulk`:

- Atomic update of N items.
- Any item out of scope → 403, zero writes.
- Empty / >200 / bad enum → 400.
- Simulated DB error mid-write → rollback, zero writes.

`GET /api/items/:id/allocation`:

- Shares match `splitTxnByItems` output.
- Item out of scope → 403.
- No linked txn → `{ allocatedTotal: null, txnId: null, ... }`.
- Multi-linked → dominant link + `linkedTxnIds`.

`GET /api/items/analytics` (PR-B):

- KPI counts sum-match `GET /api/items` for same filter.
- Trend buckets: N months × top-5 categories.
- Top items: 15 by `totalPrice DESC`.
- Heatmap: full grid; zero cells present.
- Date range >2 years → 400.
- `Cache-Control` header present.

### Frontend (Vitest + Testing Library)

`frontend/src/pages/ItemsPage.test.tsx` (new, PR-A):

- Renders 3 tabs; default `browse`; URL `?tab=search` selects Search.
- Filter chip change → URL updates → query refetches.
- Tab switch preserves filter state.
- Empty + error states render with correct copy + retry.

`frontend/src/components/items/ItemsBrowse.test.tsx` (new):

- Grouped-by-receipt with collapsible headers; group toggle switches grouping.
- Multi-select: checkbox + Shift-click range; toolbar with count.
- Bulk-edit toolbar action → `PATCH .../bulk` → clears selection on success.
- IntersectionObserver mock: sentinel triggers `fetchMore`, appends rows.

`frontend/src/components/items/ItemsSearch.test.tsx` (new):

- Debounce: query fires 300ms after last keystroke (fake timers).
- Empty `q` still queries with active filters.
- Export button → `window.open` with `format=csv` URL.

`frontend/src/components/items/ItemDetailDrawer.test.tsx` (new):

- Opens on row click; URL gets `?item=:id`.
- Closes on Esc, backdrop, route param removal.
- Inline category edit → PATCH; row reflects new value.
- Allocation panel: linked txn renders shares; unlinked renders "not linked" copy.
- Focus trap: Tab cycles within drawer.

`frontend/src/components/items/ItemsFilterStrip.test.tsx` (new):

- Each chip popover opens/closes.
- Setting a chip writes to URL.
- Cmd-click clears a chip.

`frontend/src/components/items/ItemsAnalyze.test.tsx` (new, PR-B):

- KPI strip renders 5 cards with mocked values.
- Trend chart renders `<LineChart>` with N series.
- Top-items bar renders N rows.
- Heatmap collapsed by default; expand renders cells; cell click opens drawer with prefilled filter.

`frontend/src/hooks/useItems.test.ts` (new, PR-A):

- `useItemsQuery`: loading → data → null error.
- Cancellation: filter change mid-flight discards first result.
- `fetchMore` appends, advances cursor.

### Manual verification

- Run frontend dev server, visit `/items`, click through Browse + Search.
- Confirm: tab strip + filter chips render, drawer opens on row click, multi-select toolbar appears, bulk edit applies, CSV export downloads.
- Sidebar `Items` entry navigates correctly.
- PR-B: trend + heatmap render against real data; heatmap cell click drills correctly.

## Phasing

| PR | Scope |
|---|---|
| **PR-A** | `GET /api/items` + `PATCH .../bulk` + `GET /api/items/:id/allocation` + `/items` route + `ItemsPage` + `ItemsBrowse` + `ItemsSearch` + `ItemDetailDrawer` + `ItemsFilterStrip` + `useItems` hook + sidebar entry. Analyze tab present in tab strip but body renders "Coming soon" placeholder. |
| **PR-B** | `GET /api/items/analytics` + `ItemsAnalyze` (KPI strip, trend, top-items, collapsible heatmap with drill). Removes "Coming soon" placeholder. |

Each PR ships with full test coverage for its surface. PR-B does not modify PR-A code paths beyond replacing the placeholder.

## Open questions for implementation plan

- Verify the existing route registration site in `backend/src/app.ts` (or equivalent).
- Verify `useSearchParams` is already in use elsewhere; if not, decide on the URL-sync hook shape.
- Confirm Postgres `to_tsvector` availability for `q` search; if absent, use `LOWER(title) LIKE ?` for PR-A and add FTS later.
- Confirm CSV streaming pattern exists (matters for >50k row guardrail).
- Confirm `splitTxnByItems` can be invoked per-item without recomputing the entire txn split (or accept the recompute cost on drawer open).
