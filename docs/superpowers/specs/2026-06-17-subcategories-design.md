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
- Change unique constraint: `(household_id, name)` → **`(household_id, parent_id, name)`**.
  Names are unique among siblings, reusable across the tree.
  - Note: SQLite + Postgres both treat `NULL` as distinct in a unique index, so
    two roots named "Work" would NOT collide on a naive `(household_id, parent_id,
    name)` index when `parent_id IS NULL`. Enforce root-name uniqueness with a
    **partial unique index** on `(household_id, name) WHERE parent_id IS NULL` in
    addition to the sibling index. Both dialects support partial indexes.
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

The `ensureCategory` afterSave hook on `Transaction` is extended: it resolves the
chosen node, sets `finalCategoryId`, and writes the node's **leaf name** into the
`finalCategory` mirror. Reporting reads migrate to the FK incrementally; the mirror
keeps display and any not-yet-migrated read path working.

### Invariants

- **No cycles.** Creating or reparenting validates the proposed parent is neither
  the node itself nor any of its descendants. Reject otherwise.
- **Sibling-unique names** (constraint above).
- **Delete blocked** while the node has children OR any row references it.

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

UI: a category report row renders collapsed at the parent's rolled-up total, with
a disclosure to expand into child rows.

## Budgets

A budget scoped to a parent node caps the **rolled-up subtree** total (direct
consequence of rollup semantics). Leaf-scoped budgets are unchanged.
`budgetBreachCheck.ts` consumes `aggregateSpendByCategory()`, so it inherits the
rollup with no extra logic beyond pointing budget scope at a node id.

## Tree building

### Path-syntax quick-create (picker)

The category picker accepts a path: typing `Work / Expenses / Internet` resolves
the chain segment by segment (sibling-unique match under each parent), **creating
any missing segments** under their typed parent, and tags the transaction to the
**leaf**. A bare name with no `/` resolves/creates a top-level root (preserving
today's flat behavior). New segments inherit no icon/taxTreatment (set later in the
manager).

A shared **path resolver** (`backend/src/categories/resolvePath.ts`, new) owns:
parse path → segments, walk/create the chain household-scoped, return the leaf node
id. Reused by the picker endpoint and the AI suggestion path.

### Category manager page (frontend)

New page: tree view of the household's categories. Capabilities:

- Create node (optionally under a selected parent).
- Rename, set icon, set tax treatment.
- **Drag-to-reparent** — cycle-guarded; rejected reparent shows why.
- Delete — **blocked** if the node has children or referencing transactions; the
  error offers "reparent children / reclassify transactions first" as the path.

## AI path

`ai/suggestTransaction.ts` + `loadCategoryHints()`:

- `loadCategoryHints` returns **full paths** (`Work / Expenses / Internet`) instead
  of bare leaf names, so the model sees the hierarchy.
- The suggest prompt instructs the model to return a **path**.
- The returned path goes through the shared path resolver → node id (creating the
  chain if absent). The suggestion stores `categoryId` (+ leaf-name mirror).
- The model may target any node, leaf or parent.

Receipt-item categorization (`import/categorizeReceiptItems.ts`,
`import/receiptCategories.ts`) follows the same path-based hinting + resolution.

## Migration

`backend/src/migrations/YYYYMMDD-category-tree.js`:

**up()**
1. Add `Category.parentId` (nullable self-FK).
2. Replace the unique index with the sibling index + the root partial index.
3. Add the `*CategoryId` columns listed above (all nullable).
4. **Backfill:** for each household, ensure a `Category` row exists for each
   distinct non-null category string currently in use (most already exist via the
   `ensureCategory` hook). Set every `*CategoryId` by matching its sibling string
   to a node. Existing flat categories all become **top-level roots** (`parentId`
   null) — the tree starts flat and the user nests via the manager.

**down()**
- Drop the `*CategoryId` columns, drop `parentId`, restore the
  `(household_id, name)` unique constraint. (Down assumes pre-tree flatness; the
  string mirrors are untouched and remain authoritative, so no data loss on
  rollback.)

Dual-dialect (SQLite + Postgres): use Sequelize column/index helpers; partial
indexes via `where` in `addIndex`, supported on both.

## Testing

**Model / constraint**
- Reparent that would create a cycle is rejected.
- Sibling-unique name violation rejected; same name under two parents allowed; two
  roots with the same name rejected (partial index).
- Delete blocked when node has children; blocked when transactions reference it;
  succeeds when empty.

**Aggregators**
- Multi-level subtree rollup: parent total = direct + all descendants.
- Node with both direct-tagged spend and children rolls up correctly (no double
  count).
- Item-split categories roll up identically.

**Path resolver**
- Creates a missing chain; resolves an existing chain; resolves partial (some
  segments exist); bare name → root.

**Migration**
- Backfill repoints every txn/item/suggestion/rule string to the right node id.
- down() drops cleanly and restores the old constraint.

**Frontend**
- Picker path-syntax create + tag-to-leaf.
- Manager reparent (success + cycle rejection) and delete-block messaging.
- Report row collapsed total + expand to children.

## Out of scope (YAGNI)

- Moving spend *between* currencies during rollup (rollup is per-currency, as
  today).
- Bulk re-tagging UI beyond the manager's per-node actions.
- Auto-suggesting tree structure from existing flat categories (manual nesting at
  first).
- Ripping out the `finalCategory` string mirror — kept deliberately; a later pass
  can remove it once every read path is id-based.
