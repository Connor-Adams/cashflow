# Subcategories — Plan C2c design addendum: rollup rendering + full-path display + review tagging

**Date:** 2026-06-18
**Status:** Approved. The final frontend plan; extends `2026-06-17-subcategories-design.md`.

## Three pieces (one plan, decomposed into tasks)

### 1. Rollup rendering (the payoff of B2)

B2's aggregators attach a per-currency `categoryTree: RollupRow[]` to the
`/api/summary/monthly`, `/api/summary/dashboard`, and `/api/sankey` responses, but
those rows are **untyped in `shared/api-types.ts`**. C2c first adds:
```ts
export type RollupRow = {
  categoryId: number; name: string; path: string;
  parentId: number | null; depth: number;
  currency: string; directTotal: number; rolledTotal: number;
};
```
and adds `categoryTree?: RollupRow[]` to the dashboard + monthly response types.
(Match the backend `RollupRow` in `backend/src/categories/rollup.ts` exactly.)

Then a new presentational component `CategoryRollupTree` renders the rows as a
**collapsible tree**: build a parent→children map from `parentId`, render roots
with their `rolledTotal`, expandable (disclosure) to children; filter to the view's
active currency. It is rendered **additively** — a new "Categories" section in the
Dashboard breakdown (and Monthly), **beside** the existing `TopGrowersTile`, which
is NOT removed (no regression to the current flat view).

### 2. Full-path display fix (C2a's deferral)

In `TransactionsPage`, a transaction tagged to a child currently shows the bare leaf
name (`Internet`) because the row reads `t.categoryOverride` (the leaf mirror). Fix:
derive the full path from `t.categoryOverrideId ?? t.finalCategoryId` via an
**id→path map** built from the category tree (a `pathById` helper over
`getCategoryTree`), and show that path in the row's category display + seed the
picker's edit value from it. Falls back to the string when no id/tree match.
This makes the picker round-trip lossless (the path baseline now matches, so the
`categoryFieldChanged` gate from C2a behaves correctly on re-edit).

### 3. ReviewInbox + bulk child tagging (one small backend touch)

`/api/transactions/bulk-patch` currently accepts only the `categoryOverride`
**string**. Add `categoryOverrideId` to its accepted patch fields (household-validated,
same as the single-row PATCH in C1), setting `categoryOverrideId` + `finalCategoryId`
on each affected row. Then `ReviewInboxPage`'s category control uses the path picker
(full-path options) and, on apply, resolves the path → id and bulk-patches by
`categoryOverrideId` (clearing → null). Keeps the existing string path working.

## Decomposition (tasks, in build order)

1. Shared `RollupRow` + `categoryTree` fields (+ frontend re-export).
2. `CategoryRollupTree` presentational component (+ a small `useCategoryRollup`/derive helper if needed) — pure render from `RollupRow[]`.
3. Wire `CategoryRollupTree` into the Dashboard breakdown (additive section).
4. Wire it into the Monthly view (additive section).
5. Full-path display in `TransactionsPage` (id→path map; show path; seed picker).
6. Backend `bulk-patch` accepts `categoryOverrideId` (+ integration test).
7. `ReviewInboxPage` child tagging via the path picker → bulk-patch by id.

(Tasks 3+4 may merge if the breakdown rendering is shared; the plan will decide from the actual code.)

## Testing

- `CategoryRollupTree`: builds the parent/child tree from flat `RollupRow[]`,
  renders rolled totals, expand/collapse shows children, filters by currency.
- Dashboard/Monthly: the `categoryTree` section renders when present; existing
  tiles unaffected.
- Full-path: a txn with a child `categoryOverrideId` displays its full path; picker
  edit value seeds from the path; unchanged-field save still doesn't re-tag (C2a gate).
- bulk-patch: `categoryOverrideId` sets both ids; cross-household id rejected; string
  path still works.
- ReviewInbox: applying a child path bulk-patches `categoryOverrideId`.

## Out of scope

- AI suggestion accept-time path creation (small, can be a later touch).
- Sankey rollup rendering (sankey already shows category nodes; the `categoryTree`
  field is available there but rendering it as a tree is not required for C2c).
