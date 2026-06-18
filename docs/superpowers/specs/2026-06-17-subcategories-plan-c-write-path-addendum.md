# Subcategories — Plan C design addendum: id-authoritative write path

**Date:** 2026-06-17
**Status:** Approved (extends `2026-05-30-cashflow-primitives-design.md` and the
`2026-06-17-subcategories-design.md` spec). Resolves the limitation Plan B2's
review surfaced.

## Problem (found in B2)

Plan B1's `Transaction`/`Rule`/`BudgetTarget`/`ExternalOrderItem` `beforeSave`
hooks call `resolveCategoryIdByName(string)`, which find-or-creates a **root**
category (`parentId: null`) and **re-sets `*CategoryId` on every save**. Two
consequences:

1. String-based categorization (CSV import, bookmarklet, AI) always lands
   `finalCategoryId` at a root, so B2's subtree rollup only ever sees flat roots.
2. Any explicitly-set child `finalCategoryId` is **clobbered back to a root** on
   the next save.

So a transaction cannot carry a *child* category id, which is the whole point of
the tree.

## Decision: id-authoritative when an id is provided

The category **id is the source of truth** when present; the legacy string is its
denormalized mirror. The `beforeSave` hooks change direction:

- **An explicit `*CategoryId` is set/changed** (e.g. the picker resolved a path to
  its leaf node and set `finalCategoryId`): the hook **derives the string** mirror
  from that node's leaf name (`finalCategory = node.name`) and does **not**
  re-resolve. The child id sticks.
- **Only the string is set/changed, no id** (legacy import path that knows only a
  name): the hook resolves string → **root** id via `resolveCategoryIdByName`
  (unchanged fallback), and the string stays.
- **Neither changed**: no-op.

"Changed" is detected with Sequelize's `instance.changed('finalCategoryId')` /
`instance.changed('finalCategory')`. Precedence: **id-change wins over
string-change** in the same save (if both are dirtied, the id is authoritative and
the string is overwritten from the node name).

This applies symmetrically to `Transaction` (auto/override/final),
`ExternalOrderItem` (inferred/override), `Rule.category*`, `BudgetTarget.category*`.

### Why not the alternatives

- **Name + whole-tree resolution** — sibling-unique names make a bare leaf name
  ambiguous across parents; the hook can't reliably choose the child. Rejected.
- **Store the full path string on the txn** — bloats the column and rename/reparent
  invalidate every stored path. Rejected.

## How a transaction gets a child id (the picker)

The category picker (C2) lets the user pick or type a path
(`Work / Expenses / Internet`). On selection it calls
`POST /api/categories/resolve-path` (Plan A) → leaf node id, then PATCHes the
transaction's `categoryOverrideId` (and the API recomputes `finalCategoryId`). The
write carries the **id**, so the id-authoritative hook keeps it.

This needs the transaction PATCH route to accept `*CategoryId` fields (it currently
accepts the string `categoryOverride`). C1 adds id acceptance; setting the id
derives the string mirror via the hook.

## Name-rename + mirror sync (C1)

`PATCH /api/categories/:id` gains **name** rename (today it only does
icon/taxTreatment). Rename updates `Category.name` + `nameKey` and fans the new
leaf name out to every string mirror that references the node id, via a single
service `syncCategoryLeafNameMirrors(categoryId, newLeafName, tx)` called inside
the rename transaction — across `Transaction.{autoCategory, categoryOverride,
finalCategory}`, `ExternalOrderItem.{inferredCategory, categoryOverride}`,
`Rule.category`, `BudgetTarget.category`. (Reparent does **not** change a node's
leaf name → no mirror sync; report reads already resolve the current name from the
node id via B2's tree, so reports were never stale — mirrors matter only for any
residual string-keyed reads and for display of the legacy column.)

Rename must re-check sibling-unique (`nameKey`) under the node's parent and reject
with `CategoryError('sibling_conflict')`.

## Scope split

- **Plan C1 (backend, this addendum):** id-authoritative `beforeSave` hooks;
  transaction PATCH accepts `*CategoryId`; `PATCH /api/categories/:id` name-rename
  + `syncCategoryLeafNameMirrors`. Ships an API that can tag children and rename.
- **Plan C2 (frontend):** category picker path-syntax + full-path suggestions;
  category **manager page** (tree view, create, rename, drag-to-reparent with the
  two distinct errors — cycle vs sibling-conflict — and delete-block messaging);
  render B2's per-currency `categoryTree` rollup (collapsed parent totals,
  expandable to children) in the dashboard/monthly/sankey category views; AI
  suggestion deferred (accept-time) path creation.

## Testing (C1)

- Hook: setting `finalCategoryId` to a child node sticks across re-save (not
  clobbered); string-only write still resolves to a root; id-change derives the
  string mirror = node leaf name; both-dirty → id wins.
- Transaction PATCH with `categoryOverrideId` sets the override id + derives the
  string + recomputes `finalCategoryId`.
- Rename: fans out to all mirror columns in one transaction; rejects sibling
  conflict; reparent does not trigger mirror sync.
