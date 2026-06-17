# Subcategories — Category Tree

**Date:** 2026-06-17
**Status:** Design approved, pre-implementation

## Summary

Turn the flat, free-form `Category` list into an **arbitrary-depth tree**. A
transaction tags exactly one category node (top-level or deep leaf — it doesn't
care which); the hierarchy lives on the `Category` table and is resolved at
reporting time. Reports show a parent's total as **its own directly-tagged spend
plus all descendants**, collapsed by default and expandable to drill in.

Example tree:

```
Work
└─ Expenses
   └─ Internet
      ├─ Office 1
      └─ Office 2
```

## Primitives-spine classification

Not a new primitive. `Category` is a **reference attribute** of the Transaction
primitive (the categorization dimension), not a status machine of its own. Adding
`parentId` is a **variant of the existing Category table** — three checks:

1. Extends exactly one thing — Transaction's categorization attribute. ✓
2. Persistent state (the tree shape), owned by `Category`. ✓
3. Does not mirror another primitive's machine. ✓

No spine change. It is a data-model enrichment of an existing reference table.

## Decisions (locked during brainstorming)

| # | Decision | Choice |
|---|----------|--------|
| Depth | How deep can the tree go? | **Arbitrary depth**, no artificial cap. |
| Rollup | How do reports show a parent? | **Self + all descendants**, collapsed/expandable. |
| Identity | What identifies a category? | **`id` (FK)** — true tree semantics. |
| Naming | Can a name repeat under different parents? | **Yes, sibling-unique** (`Work/Internet` and `Home/Internet` coexist). |
| Build | How is the tree organized? | **Both** path-syntax quick-create in the picker **and** a manager page. |
| Delete | Deleting a non-empty node? | **Block** if it has children or transactions; offer reparent/clear. |
| Mirror | Keep the denormalized `finalCategory` string? | **Yes**, as a synced display/leaf-name mirror to de-risk the read-path migration. |

## Data model

### `Category` table changes

- Add `parentId` — self-referential FK to `Category.id`, **nullable** (`null` =
  top-level root). `ON DELETE RESTRICT` (delete is blocked while children exist
  anyway; see Delete behavior).
- Add **`nameKey`** — a persisted normalized key, `trim(name).toLocaleLowerCase("en-CA")`,
  set by the category service on every create/rename. `name` keeps the user's
  display casing; `nameKey` is what uniqueness and lookups key on. This pushes
  case-insensitive uniqueness into the **DB index** rather than trusting each write
  path to normalize. (Persisted column, not a generated column — dual-dialect
  generated-column support is uneven; the service owns the value.)
- Unique constraints key on `nameKey`, not `name`:
  - **sibling:** `(household_id, parent_id, name_key) WHERE parent_id IS NOT NULL`
  - **root:** `(household_id, name_key) WHERE parent_id IS NULL`
  - Both partial, because SQLite + Postgres treat `NULL` as distinct in a unique
    index (two roots named "Work" would not collide on a naive sibling index when
    `parent_id IS NULL`); the root index owns root uniqueness. Both dialects support
    partial indexes.
- **Write discipline (defense-in-depth):** all category creates/renames go through
  the category service (which sets `nameKey`); no raw `Category.create()` / direct
  `name` updates elsewhere. The DB index is the backstop, the service is the path.
- Existing columns (`name`, `icon`, `taxTreatment`) unchanged.

### Identity: string → id (with mirror)

Category reference moves from name-string to `id` FK. Each site that tags a
category gains a nullable `*CategoryId` FK **and keeps its existing string column
as a denormalized mirror** synced to the referenced node's leaf name:

| Model | Existing string col(s) | Added FK |
|-------|------------------------|----------|
| `Transaction` | `autoCategory`, `categoryOverride`, `finalCategory` | `autoCategoryId`, `categoryOverrideId`, `finalCategoryId` |
| `ExternalOrderItem` | `inferredCategory`, `categoryOverride` | `inferredCategoryId`, `categoryOverrideId` |
| `AiSuggestion` | `category` | `categoryId` |
| Rules | `category` | `categoryId` |
| `BudgetTarget` | `category` (`null` = "overall") | `categoryId` (`null` = "overall") |

The `ensureCategory` afterSave hook on `Transaction` is extended: it resolves the
chosen node, sets `finalCategoryId`, and writes the node's **leaf name** into the
`finalCategory` mirror. Reporting reads migrate to the FK incrementally; the mirror
keeps display and any not-yet-migrated read path working.

`BudgetTarget.categoryId` null continues to mean **"overall"** (covers the sum of
all spend in the matching currency); a non-null id scopes the budget to that node's
**rolled-up subtree** (see Budgets).

### Mirror sync on rename (must-fix)

Because the string columns are denormalized mirrors of a node's **leaf name**,
renaming a category must update every mirror that references that `categoryId`:
`Transaction.{autoCategory, categoryOverride, finalCategory}`,
`ExternalOrderItem.{inferredCategory, categoryOverride}`, `AiSuggestion.category`,
Rules `category`, `BudgetTarget.category`.

Do **not** scatter hooks. Add a single service:

```ts
// backend/src/categories/syncMirrors.ts
syncCategoryLeafNameMirrors(categoryId, newLeafName, tx)
```

Called from the rename mutation **inside the same DB transaction** as the
`Category.name` update, so a rename and its mirror fan-out commit atomically.
Reparent does **not** change a node's leaf name, so it does not trigger mirror sync
(only its `path` changes, and `path` is computed at read time, never stored on the
mirrors).

### Invariants

- **No cycles.** Creating or reparenting validates the proposed parent is neither
  the node itself nor any of its descendants. Reject otherwise.
- **Sibling-unique names**, enforced **case-insensitively** via the persisted
  `nameKey` (`Internet` / `internet` / `INTERNET` collapse to one sibling)
  independent of DB collation. The unique indexes on `name_key` are the backstop;
  the category service sets `nameKey` on write. `name` keeps display casing.
- **Delete blocked** while the node has children OR is referenced by any of:
  `Transaction.{autoCategoryId, categoryOverrideId, finalCategoryId}`,
  `ExternalOrderItem.{inferredCategoryId, categoryOverrideId}`,
  `AiSuggestion.categoryId`, Rules `categoryId`, `BudgetTarget.categoryId`, or child
  categories. The backend check is comprehensive across **all** of these; the
  user-facing error may simplify the message and suggest reparent/reclassify.

## Reporting / rollup

All aggregators that group by category gain a **subtree rollup** step:

- `summary/aggregateMonthly.ts`
- `summary/aggregateSankey.ts`
- `summary/aggregateDashboard.ts`
- `routes/budgets.ts` → `aggregateSpendByCategory()`
- `ai/insights.ts`

Mechanism: group raw spend by the **node id** it is tagged to, then fold each
node's total up its ancestor chain so every ancestor's reported total includes the
node. A parent line therefore = direct-tagged spend on that parent + sum of all
descendants. The item-level split (`splitTxnByItems()`) still applies first; its
resulting item categories are node ids that roll up the same way.

Build the ancestor chain once per request from a single `Category` fetch
(household-scoped, typically small) — resolve parents in memory, no N+1 recursion
in SQL.

**Shared rollup utility** (`backend/src/categories/rollup.ts`, new) consumed by all
aggregators. Per currency, two maps — raw (spend on the tagged node only) and rolled
(folded up the chain):

```
parentById: Map<categoryId, parentId|null>     // from the single Category fetch
rawByCategoryId:    Map<categoryId, amount>     // grouped once by tagged node
rolledByCategoryId: Map<categoryId, amount>

for [categoryId, amount] of rawByCategoryId:
  current = categoryId
  while current != null:
    rolledByCategoryId[current] += amount
    current = parentById[current]
```

No double-count: raw spend is grouped exactly once by its tagged node, then folded.
A node tagged directly **and** having children sums correctly — e.g. parent $50 +
child $20 + grandchild $30 → parent rolled = $100. Multi-currency keeps the existing
`Map<currency, Map<categoryId, amount>>` shape; roll up within each currency.

UI: a category report row renders collapsed at the parent's rolled-up total, with
a disclosure to expand into child rows. Each row carries
`{ categoryId, name, path, parentId, depth, directTotal, rolledTotal, children }`
— UI may show only `rolledTotal`, but `directTotal` is kept for debugging and a
future "direct spend only" view.

## Budgets

Budget category scope lives on **`BudgetTarget.category`** (`STRING(128)`, nullable,
`null` = "overall"; has the `ensureCategory` hook). It gains **`categoryId`** FK (+
string mirror), exactly like the other tagging sites. A budget scoped to a parent
node caps the **rolled-up subtree** total (direct consequence of rollup semantics);
`categoryId == null` keeps "overall" semantics; leaf-scoped budgets are unchanged.
`budgetBreachCheck.ts` consumes `aggregateSpendByCategory()`, so it inherits the
rollup once budget scope points at a node id.

## Tree building

### Path-syntax quick-create (picker)

The category picker accepts a path: typing `Work / Expenses / Internet` resolves
the chain segment by segment (sibling-unique match under each parent), **creating
any missing segments** under their typed parent, and tags the transaction to the
**leaf**. A bare name with no `/` resolves/creates a top-level root (preserving
today's flat behavior). New segments inherit no icon/taxTreatment (set later in the
manager).

Because duplicate leaf names are allowed across the tree, the picker's suggestion
list shows the **full path**, not the bare leaf, to disambiguate:

```
Internet
Work / Expenses / Internet
Home / Internet
```

A shared **path resolver** (`backend/src/categories/resolvePath.ts`, new) owns:
parse path → segments, walk/create the chain household-scoped, return the leaf node
id. Reused by the picker endpoint and the AI suggestion path.

**Parsing rules:**
- Split on `/`; **trim** each segment; **reject empty segments** (so `Work//Internet`
  and a trailing `/` are errors).
- Category **names may not contain `/`** (it is the path separator).
- A path with no `/` is a single **root** segment.
- Sibling matching is **case-insensitive** (see Invariants).

```
"Work / Expenses / Internet"  -> ["Work","Expenses","Internet"]
" Work / Internet "           -> ["Work","Internet"]
"Internet"                    -> root "Internet"
"Work//Internet"             -> reject (empty segment)
```

**Concurrency safety:** path quick-create is race-prone — two requests creating
`Work / Expenses / Internet` simultaneously. The resolver runs **inside a DB
transaction** and, per segment, treats a unique-constraint violation as
"someone else created it first → re-read the sibling and continue":

```
for each segment under `parent`:
  key  = normalize(name)                              // trim + toLocaleLowerCase("en-CA")
  node = findSibling(householdId, parentId, key)      // lookup by name_key
  if !node:
    try   node = create({ name, nameKey: key, parentId })
    catch UNIQUE_VIOLATION: node = findSibling(...)   // re-read winner
  parent = node
return leaf node id
```

This makes picker, AI, and import categorization safe under concurrent writes.

### Category manager page (frontend)

New page: tree view of the household's categories. Capabilities:

- Create node (optionally under a selected parent).
- Rename, set icon, set tax treatment. (Rename fans out to mirrors — see Mirror
  sync on rename.)
- **Drag-to-reparent** — surfaces **two distinct errors** the user can act on
  differently: (a) *would create a cycle* (can't drop a node into its own subtree),
  and (b) *target parent already has a sibling with that name* (case-insensitive
  collision). Different actions, different messages.
- Delete — **blocked** if the node has children or any referencing row (see Delete
  blocked invariant); the error offers "reparent children / reclassify
  transactions first" as the path.

## AI path

`ai/suggestTransaction.ts` + `loadCategoryHints()`:

- `loadCategoryHints` returns **full paths** (`Work / Expenses / Internet`) instead
  of bare leaf names, so the model sees the hierarchy.
- The suggest prompt instructs the model to return a **path**.
- The model may target any node, leaf or parent.

**AI does not mutate the tree before user acceptance.** A hallucinated path must not
silently create branches. Resolution is two-phase:

- On suggest: resolve the returned path to an **existing** node if possible. If it
  resolves, store `categoryId` (+ mirror). If it does **not** fully resolve, store
  the **pending path string** on the suggestion (no nodes created).
- On **accept**: run the path through the shared resolver (creating any missing
  chain) and set the transaction's `categoryOverrideId`.

Picker / manual entry creates immediately (the user typed it on purpose); only the
AI/import path defers creation to acceptance.

Receipt-item categorization (`import/categorizeReceiptItems.ts`,
`import/receiptCategories.ts`) follows the same path-based hinting + resolution.

## Migration

`backend/src/migrations/YYYYMMDD-category-tree.js`:

**up()** (order matters — create constraints before relying on them):
1. Add `Category.parentId` (nullable self-FK) and `Category.nameKey`.
2. Add the `*CategoryId` columns listed above (all nullable).
3. **Backfill `nameKey`** for existing rows (`trim(name).toLocaleLowerCase("en-CA")`).
   If two existing rows collide on `(household_id, name_key)` after normalization
   (e.g. "Food" and "food"), the migration must surface/merge them before the unique
   index is added — log and fail loudly rather than silently drop one.
4. **Create the new indexes** (sibling + root partial, on `name_key`) — after
   `nameKey` backfill so they validate cleanly.
5. **Backfill categories:** for each household, ensure a `Category` row exists for
   each distinct non-null category string currently in use (most already exist via
   the `ensureCategory` hook). Existing flat categories all become **top-level
   roots** (`parentId` null) — the tree starts flat; the user nests via the manager.
6. **Backfill FK columns** by matching each old string mirror to its root category
   row (household-scoped, by `name_key`).
7. **Drop the old `(household_id, name)` unique constraint** only after the
   sibling/root indexes exist — in a transaction where the dialect supports it.

**down()**
- Drop the sibling/root partial indexes, the `*CategoryId` columns, `parentId`, and
  `nameKey`; restore the `(household_id, name)` unique constraint. The string mirrors
  are untouched and remain authoritative, so rollback to pre-tree flatness loses no
  data.

**Dual-dialect / column-name care (SQLite + Postgres):**
- Models likely use `underscored: true` — Sequelize attribute `parentId` maps to DB
  column `parent_id`. **Partial indexes must reference the real DB column names**
  (`parent_id`, `household_id`), not the model attribute names.
- Partial unique indexes via `where` in `addIndex` are supported on both dialects,
  keyed on `name_key` (not `name`):
  ```
  sibling: unique (household_id, parent_id, name_key) WHERE parent_id IS NOT NULL
  root:    unique (household_id, name_key)            WHERE parent_id IS NULL
  ```
  Filtering the sibling index keeps root uniqueness cleanly owned by the root index.

## API surface

Backend additions (gated routes, household-scoped):

```
GET    /api/categories/tree          -> nested tree with directTotal/rolledTotal per node
POST   /api/categories/resolve-path  -> { id, name, path, createdIds: string[] }
POST   /api/categories               -> create (optional parentId)
PATCH  /api/categories/:id           -> rename / icon / taxTreatment (fans out mirror sync)
PATCH  /api/categories/:id/reparent  -> { newParentId } (cycle + sibling-collision guarded)
DELETE /api/categories/:id           -> blocked if non-empty (comprehensive reference check)
```

`resolve-path`'s `createdIds` lists nodes created during the walk — useful for UI
feedback ("created Work › Expenses") and debugging. The existing flat
`GET /api/categories` stays for back-compat during transition.

## Testing

**Model / constraint**
- Reparent that would create a cycle is rejected.
- Sibling-unique violation rejected; same name under two parents allowed; two roots
  with the same name rejected (root partial index on `name_key`);
  `Internet`/`internet`/`INTERNET` collapse to one sibling (`nameKey`).
- Delete blocked when node has children; blocked independently for each referencing
  table (`Transaction`, `ExternalOrderItem`, `AiSuggestion`, Rules, `BudgetTarget`);
  succeeds when fully empty.

**Mirror sync**
- Rename fans out `syncCategoryLeafNameMirrors` to every mirror column; rename +
  fan-out commit atomically (rollback on failure leaves no partial rename).
- Reparent does **not** alter mirrors.

**Aggregators / rollup**
- Multi-level subtree rollup: parent total = direct + all descendants.
- Node with both direct-tagged spend and children rolls up correctly (no double
  count): parent $50 + child $20 + grandchild $30 → parent rolled $100.
- Item-split categories roll up identically.
- Multi-currency rolls up within each currency, no cross-currency leakage.
- Budget scoped to a parent breaches on the rolled-up subtree; `null` budget = overall.

**Path resolver**
- Creates a missing chain; resolves an existing chain; resolves partial; bare name →
  root; rejects empty segments / names containing `/`.
- **Concurrency:** two simultaneous creates of the same path converge on one node
  (unique-violation → re-read winner), no duplicate siblings.

**AI path**
- Suggestion with an existing path stores `categoryId`; with a non-existing path
  stores the pending path and creates **no** nodes; accept creates the chain.

**Migration**
- `nameKey` backfill normalizes existing rows; pre-existing case-collisions
  (`Food`/`food`) fail loudly, not silently dropped.
- FK backfill repoints every txn/item/suggestion/rule/budget string to the right
  node id (matched by `name_key`).
- down() drops cleanly and restores the old constraint.

**Frontend**
- Picker path-syntax create + tag-to-leaf; suggestion list shows full paths.
- Manager reparent (success, cycle rejection, sibling-collision rejection — distinct
  messages) and delete-block messaging.
- Report row collapsed `rolledTotal` + expand to children.

## Implementation order

1. Migration + model associations (`parentId`, FK columns, indexes).
2. **Category service** (`backend/src/categories/`): path resolver (+ concurrency),
   cycle guard, reparent, comprehensive delete blockers, `syncCategoryLeafNameMirrors`.
3. Backfill + migration tests.
4. **Shared rollup utility**, consumed by monthly / sankey / dashboard / budgets /
   insights.
5. Move transaction / item / rule / suggestion / budget writes to ids (mirrors synced).
6. Picker path entry + full-path suggestion display.
7. Category manager page.
8. AI full-path hints + deferred (accept-time) resolution.
9. (Later) remove remaining read-path string dependence once all reads are id-based.

## Out of scope (YAGNI)

- Moving spend *between* currencies during rollup (rollup is per-currency, as
  today).
- Bulk re-tagging UI beyond the manager's per-node actions.
- Auto-suggesting tree structure from existing flat categories (manual nesting at
  first).
- Ripping out the `finalCategory` string mirror — kept deliberately; a later pass
  can remove it once every read path is id-based.
