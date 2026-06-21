# Subcategories — Plan C2 design addendum: frontend

**Date:** 2026-06-17
**Status:** Approved. Extends `2026-06-17-subcategories-design.md` (frontend
sections) with concrete decomposition + decisions for the Cashflow React frontend.

## Decomposition (3 sub-plans, each its own PR)

- **C2a — picker + child tagging** (ship first; depends only on merged C1):
  upgrade the category picker to path-syntax and tag transactions to a *child*
  node via `categoryOverrideId`.
- **C2b — category manager**: extend the existing `CategoriesTab`
  (`/settings?tab=categories`) into a tree manager — create child, rename,
  drag-to-reparent, delete-block.
- **C2c — rollup rendering**: type `categoryTree`/`RollupRow` in shared, render a
  collapsible per-currency rollup tree in the dashboard/monthly category views.

## Decisions

- **Reparent UX = drag-and-drop** (new dep `dnd-kit`, C2b only). Cycle and
  sibling-conflict map to the two distinct error messages C1's
  `PATCH /:id/reparent` returns (`code: 'cycle'` vs `'sibling_conflict'`).
- **Extend `CategoryCloudPicker`** (don't replace) for path-syntax; it stays a
  string-in/string-out component for display but its host gains a path→id resolve
  step on select.
- **Extend `CategoriesTab`** (don't add a new page) for the manager.
- **Shared types**: `RollupRow` + the `categoryTree` field on the summary/dashboard/
  sankey responses must be added to `shared/api-types.ts` (B2 returns them
  untyped) — done in C2c before rendering.

## C2a detail (the plan that follows this addendum)

**Data flow for tagging a child:** the picker offers full paths (e.g.
`Work / Expenses / Internet`) from `GET /api/categories/tree`; on select (or a
free-typed path), the host calls `POST /api/categories/resolve-path { path }` →
`{ id, name, path, createdIds }`, then `PATCH /api/transactions/:id
{ categoryOverrideId: id }`. C1's id-authoritative hook derives the strings; the
row's displayed category updates from the response. A bare name with no `/` still
works (resolves/creates a root) — preserving today's flat behavior.

**API client additions** (`frontend/src/lib/api.ts` is just fetch wrappers; add
typed helpers in a small `frontend/src/lib/categoriesApi.ts`):
- `getCategoryTree(): Promise<CategoryTreeNode[]>` → `GET /api/categories/tree`.
- `resolveCategoryPath(path): Promise<ResolvedPath>` → `POST /api/categories/resolve-path`.

**Picker changes:** `CategoryCloudPicker` gains an `options` list of full paths
(the host builds them from the tree) and keeps its string value API. Suggestion
display shows the full path so duplicate leaf names disambiguate. Free-typed text
containing `/` is accepted as a path.

**Hosts:** `TransactionsPage` + `ReviewInboxPage` change their category save from
`PATCH { categoryOverride: string }` to: resolve the chosen path → id, then
`PATCH { categoryOverrideId: id }` (clearing → `categoryOverrideId: null`).

## Testing (vitest + testing-library)

- Picker: renders full-path options; selecting a path calls the resolve+patch flow
  (mock `api`); free-typed path is accepted.
- categoriesApi helpers: shape the request/response correctly (mock `getJson`/`postJson`).
- Host save: choosing a child path PATCHes `categoryOverrideId` with the resolved id.

## Out of scope for C2a (C2b/C2c)

- Manager page tree/create/rename/reparent/delete (C2b).
- `RollupRow`/`categoryTree` shared types + collapsible rollup rendering (C2c).
- AI suggestion accept-time path creation (fold into C2a's picker or C2b — small).
