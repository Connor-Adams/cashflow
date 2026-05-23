# Wave 2a — Transactions decomposition

**Date:** 2026-05-23
**Status:** approved (brainstorming), implementing
**Scope:** one PR. Splits `frontend/src/pages/TransactionsPage.tsx` (2,593 lines, swiss-army knife) into three focused routes. Wave 2b (Review Inbox polish) is a separate PR.

**Predecessor:** [`2026-05-23-wave-1-sidebar-bento-expansion-design.md`](./2026-05-23-wave-1-sidebar-bento-expansion-design.md)

---

## Goals

1. Move ingestion (upload + import history) out of `/transactions` into a dedicated `/import` route.
2. Move batch-scoped post-import work (AI cleanup) into a per-batch detail route `/import/:batchId`.
3. Leave `/transactions` as a focused table-centric surface: filter / inline-edit / bulk-edit / AI suggestions / AI audit.
4. Add an Import nav item to the sidebar.
5. Add a drill-back affordance from `/transactions` to `/import/:batchId` when the batch filter is active.

## Non-goals

- Extracting the transactions table itself as a reusable component (out of scope tax — defer).
- No backend changes. All `/api/import/*`, `/api/transactions/*`, `/api/ai/*` endpoints unchanged.
- No new design tokens. Reuses existing `.uploadCard`, `.aiVisibilityPanel`, table styling.
- No Review Inbox changes (Wave 2b).

---

## Section A — Routes + sidebar

| Route | Purpose | Component |
|---|---|---|
| `/transactions` | Table + filter + inline-edit + bulk-edit + AI suggestions + AI audit | `TransactionsPage.tsx` (modified) |
| `/import` | Upload form + list of past imports | `ImportPage.tsx` (new) |
| `/import/:batchId` | Batch metadata + AI cleanup + drill to transactions | `ImportBatchPage.tsx` (new) |

**Sidebar nav** — add `Import` item between `Transactions` and `Portfolio`. Icon: lucide `Upload`. Reuses the `navItems` shape in `Sidebar.tsx`.

---

## Section B — `/import` page

Single-column vertical stack.

```
PageHeader: "Import" / "CSVs, OFX exports, or Wealthsimple bundles."

<UploadCard />          // full width, prominent
<ImportHistoryTable />  // full width, click row → /import/:batchId
```

**UploadCard** (`frontend/src/components/import/UploadCard.tsx`) extracted from TransactionsPage. Two modes (Standard CSV/OFX vs Wealthsimple bundle), file picker, preview, commit. Reuses `.uploadCard`, `.previewBlock`, `.parseErrorList` styles.

**ImportHistoryTable** (`frontend/src/components/import/ImportHistoryTable.tsx`) extracted from TransactionsPage. Columns: date, file, mode, rows, status. Optional badge for AI cleanup status when the batch has flagged items. Takes `onRowClick(batchId)` prop; the `/import` page navigates to `/import/${batchId}`.

---

## Section C — `/import/:batchId` page

```
PageHeader: "Import #<batchId>" / "<uploaded date> · <file> · <rows> rows"

<BatchSummary />        // status, currency, mode, uploaded date; "View transactions →" link
<AICleanupPanel />      // existing AI cleanup JSX, batch-scoped
```

**BatchSummary** is inline JSX in `ImportBatchPage.tsx` — small enough that a separate component isn't worth the indirection.

**AICleanupPanel** (`frontend/src/components/import/AICleanupPanel.tsx`) extracted from TransactionsPage. Consumes `/api/ai/import-cleanup?batch=<id>&currency=<x>`. Renders the same `.aiVisibilityPanel` JSX it does today, just on its own page now. Props: `batchId`, `currency`.

**"View transactions →" link** routes to `/transactions?importBatch=<id>&currency=<x>` — deep-links into the editing surface with the batch filter pre-applied.

**Data source for batch metadata:** fetch `/api/import/history` (same endpoint the import history table uses) and pick the matching row. Avoids inventing a new `/api/import/:batchId` endpoint. The page renders a "Batch not found" empty state if the id doesn't match anything (e.g. stale URL).

---

## Section D — `/transactions` modifications

**Removed sections:**
- The `<Card>` containing the UploadCard JSX
- The `<Card>` containing the import-history panel
- The conditional AI cleanup panel that fired when batch filter was active
- The `.transactionsTopGrid` wrapper that held upload + history side-by-side
- All state, effects, and handlers exclusively scoped to those sections (upload file, preview, history fetch, AI cleanup fetch, etc.)

**Kept unchanged:**
- Stats row (5 cards — filtered count, page count, review needs, selections, receipts)
- Filter bar (currency, dates, category, importBatch, reviewFlag)
- Transactions table with inline editing
- Bulk-edit bar (`/api/transactions/bulk-patch`, `/api/transactions/bulk-patch-filter`)
- AI suggestions panel (`/api/ai/transactions/suggest` — selection-based, general tool)
- AI audit panel (`/api/ai/transactions/audit` — selection-based, general tool)

**Added — drill-back affordance:** When the `importBatch` filter chip renders (because the query string has `importBatch=<id>`), wrap it in a `<Link to={`/import/${batchId}`}>` so the user can click to the batch detail. Visual: same chip styling, just clickable.

---

## Section E — Migration

One PR. Order within:

1. **Extract `UploadCard`** to `frontend/src/components/import/UploadCard.tsx`. Move JSX + the state/handlers it owns (file selection, preview, commit, mode toggle, Wealthsimple bundle commit). Wire it as `<UploadCard onCommitted={refetch} />` so the caller can refresh its history after a successful commit.
2. **Extract `ImportHistoryTable`** to `frontend/src/components/import/ImportHistoryTable.tsx`. Owns the `/api/import/history` (or whichever existing endpoint) fetch. Exposes `onRowClick(batchId)` prop and a `refresh()` imperative handle (or render-prop with a refresh callback) so UploadCard's onCommitted can trigger a re-fetch.
3. **Extract `AICleanupPanel`** to `frontend/src/components/import/AICleanupPanel.tsx`. Takes `batchId` and `currency` props. Owns the `/api/ai/import-cleanup` fetch and the accept/reject handlers.
4. **Create `ImportPage`** at `frontend/src/pages/ImportPage.tsx`. Composes `<PageHeader>`, `<UploadCard>`, `<ImportHistoryTable>` with the onRowClick that calls `navigate('/import/${batchId}')`.
5. **Create `ImportBatchPage`** at `frontend/src/pages/ImportBatchPage.tsx`. Uses `useParams()` for `batchId`. Fetches `/api/import/history`, finds matching row, renders header + BatchSummary + `<AICleanupPanel>` + "View transactions →" link.
6. **Register routes** in `frontend/src/App.tsx` — add `<Route path="/import" element={<ImportPage />} />` and `<Route path="/import/:batchId" element={<ImportBatchPage />} />`.
7. **Add sidebar nav item** in `frontend/src/components/Sidebar.tsx` — insert `{ to: '/import', label: 'Import', icon: Upload }` between Transactions and Portfolio.
8. **TransactionsPage cleanup** — delete the three moved sections + their state/effects/handlers. Verify imports list is clean (drop `Upload`, file-handling utilities, AI cleanup type definitions that are no longer used).
9. **Drill-back chip** — locate the `importBatch` filter chip in TransactionsPage's filter bar; wrap in `<Link>` when the value is non-empty.

### Compatibility

- Existing CSS classes (`.uploadCard`, `.aiVisibilityPanel`, `.previewBlock`, etc.) reused on new pages — no token churn.
- Bookmarks/links to `/transactions?importBatch=X` continue to work (filter wiring stays intact).
- `/api/*` endpoints unchanged.
- The Wealthsimple bundle commit path moves with UploadCard (its mode toggle and bundle-specific commit handler).

### Risks

- **Extraction surgery on a 2,593-line file**. State coupling is the main risk — handlers that read from filter state, share state with the bulk bar, etc. I'll move JSX + state + effects + handlers as cohesive units and run typecheck after each extraction.
- **`onCommitted` refresh wiring** — UploadCard needs to tell ImportHistoryTable to re-fetch. Options: prop callback (simpler, slight prop drilling), or both subscribe to a query-cache invalidation (overkill for this app). Use the prop callback.
- **Stale batch URL** — `/import/:batchId` with a non-existent id should show "Batch not found" rather than a broken page. Empty state handles this.
- **AI cleanup timing differs slightly** — was conditional on `/transactions` filter; now fires on `/import/:batchId` mount. Same net behavior, slightly different trigger. Acceptable.
- **Fallow audit gate** — TransactionsPage shrinks substantially, which might surface new duplications or shifted complexity scores. Address inline if blocking, admin-merge otherwise.

### Verification

- `yarn workspace frontend run lint`, `tsc -b`, vitest, `vite build` — all clean.
- Manual flow: visit `/import`, upload a small CSV, confirm preview + commit, land at `/import/:batchId`, AI cleanup loads, "View transactions →" lands at `/transactions?importBatch=...`.
- Manual on `/transactions`: filter / sort / inline-edit / bulk-edit / AI suggestions / AI audit all work; batch chip is clickable when present.
- Sidebar Import item appears, active state highlights on `/import` and `/import/:batchId`.

### Deferred to follow-ups

- Extract the transactions table itself as a reusable component (would let `/import/:batchId` show that batch's transactions inline instead of linking out). Bigger refactor; not required to ship the decomposition.
- AI cleanup status badge on import history rows (requires querying cleanup state per batch; needs either a small new endpoint or batched cleanup-state fetch).
- Pagination on `/import` history if the list grows long (currently unbounded; fine for now).
