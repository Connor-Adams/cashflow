# Duplicate categories: root cause, merge, and the constraint that prevents recurrence

Household 1, found 2026-09-30 while populating `budget_targets`.

## 1. What happened

Fifteen category names exist twice in household 1 — once as a root
(`parent_id IS NULL`) and once nested under a parent. The two partial unique
indexes permit it: `categories_household_root_name_key_unique` is partial on
`parent_id IS NULL` and `categories_household_parent_name_key_unique` on
`parent_id IS NOT NULL`, so a name can be both a root and a child without
colliding.

### The creating actor

`job_runs` id 220201 — **`enrichment_backfill`, 2026-09-29 04:00:00 →
04:08:02, 482,281 ms**. Its neighbouring runs take ~60,000 ms. Every one of the
17 categories created that day (the 15 dup roots, ids 69–85, plus children 74
`Household / Office Equipment` and 84 `Household / Beverages`) carries a
`created_at` between **04:07:29 and 04:08:01** — the last 33 seconds of that
run, which is the AI tail.

Nothing else in the window touched categories: no `import_histories` rows after
02:00, no `rules` writes, no `audit_log` entries (audit does not cover
categories at all), and the only transaction writes were 7 rows at 04:00–04:01.

### The mechanism

`import/enrichment/aiBatchOverColdRows.ts:188` calls
`ensureCategory(householdId, merged.fields.autoCategory)`, which routes through
`util/ensureCategory.ts` to `categories/resolvePath.ts:19`:

```ts
return Category.findOne({ where: { householdId, parentId, nameKey }, transaction });
```

That lookup is **strictly parent-scoped**. When the AI returns a flat name like
`"Ai"`, the walk starts at `parentId = null`, misses (the real node is
`Subscriptions / Ai`, id 28), and `Category.create({ parentId: null })` spawns a
duplicate **root**. When the AI returns a path the tree does not have —
`"Household / Office Equipment"` — it creates a duplicate **child** under a
parent that resolved fine, while the canonical `Office Equipment` sits at the
root.

Commit `8e9c4f5c` (2026-06-18, *"Stop name-based categorization from forking
nested categories"*) added root-preference and single-nested-match reuse to
`resolveCategoryIdByName`. It did not touch `resolveCategoryPath`, and
`ensureCategory` goes through `resolveCategoryPath`. **The June fix was
incomplete, not undeployed.**

### The same run explains two other tickets

`ai/suggestTransaction.ts:15` — `loadCategoryHints` returns
`[...new Set(tree.pathById.values())]`, i.e. **path-form** strings
(`"Household / Rent"`). Those go to the model as the menu of valid categories,
so the model echoes them back verbatim.

`aiBatchOverColdRows.ts:164` then writes them with a **static**
`Transaction.update`, which bypasses the `beforeSave` hook, so `final_category`
receives the raw string and `final_category_id` stays NULL. `ensureCategory`
runs afterwards and creates the nodes, but returns `void` — the leaf id is
discarded.

The in-code note at `:163` claims *"Migration 20260623000001 backfills any null
FKs"*. That migration is a one-shot Sequelize migration that ran in June. Nothing
has backfilled since. The comment is false and is removed by this work.

Current damage in prod, household 1:

| shape | rows |
|---|---|
| flat `final_category` string, `final_category_id` NULL | **2,804** across 20 names |
| path-form `final_category` (`"A / B"`), id NULL | **198** across 23 strings |
| duplicate category pairs | **15** |

`amazon/aiCategorizeAmazonItems.ts:341` has the same static-update bypass with
no compensating `ensureCategory` at all.

## 2. Why naive merging is dangerous, and why most of it is not

Budget matching resolves a budget's `category_id` to its subtree via
`categoryAndDescendantNames` (`routes/budgets.ts:26`) and then joins to spend
**by name string** — `spendByCategory` is keyed
`` `${alloc.currency}\0${alloc.category ?? ''}` `` at `routes/budgets.ts:575`,
where `alloc.category` is the raw `transactions.final_category`.

Two consequences:

1. Both halves of every duplicate pair share a name, so **spend is already
   unified today**. Repointing `budget_targets.category_id` between two
   *childless* nodes changes the name set not at all.
2. Repointing onto a node that *has* children silently widens what the budget
   counts.

Only two pairs have a child with children of its own:

- **Golf** — budget 17 points at root 76 (childless). Child 19 has `Clublink`
  (16), budgeted separately at 879 by budget 2. Repointing 17 → 19 would make
  the $50 Golf budget swallow Clublink.
- **Clothing** — budget 16 points at root 75 (childless). Child 13 has
  `Snowboarding Gear` (23).

Three premises in the original ticket are wrong and are corrected here:

- `budget_targets` was created **2026-09-30 02:32**, a day *after* the duplicate
  categories. The budgets did not cause the fork; the seeder resolved names
  against an already-forked tree. There are 23 rows, not 25.
- **There is no Travel budget.** Root 73 `Travel` has zero references in every
  column. It is a pure delete, not a trap.
- **Office Equipment is inverted.** Root 14 is canonical (2026-05-24, children
  `Desk` + `Laptop`, 128 `external_order_items`, holds budget 18); child 74 is
  the empty 09-29 duplicate. The loser is the child.

`budget_targets` rows 7 (`Household`) and 22 (`Hobbies`) carry a non-NULL
`category` string with `category_id = NULL`. That is not "sum everything" — it
falls to the `else` branch at `routes/budgets.ts:698`, an exact
`CAD\0Household` key match with no subtree rollup. This is the mechanism that
keeps `Household` from double-counting Rent, Groceries, Internet and the rest,
and it is what Golf and Clothing adopt below.

## 3. Reference census

Winner is the node that keeps every reference; loser is deleted.

| name | loser | loser txns | winner | winner txns | winner kids | budget |
|---|---|---|---|---|---|---|
| Ai | 85 root | 1 | 28 | 7 | 0 | — |
| Alcohol | 81 root | 3 | 30 | 28 | 0 | 12 |
| cc fees | 72 root | 1 | 31 | 108 | 0 | 5 |
| Clothing | 75 root | 0 | 13 | 4 | **1** | 16 |
| Diabetes | 83 root | 1 | 24 | 21 | 0 | — |
| Discord Nitro | 79 root | 0 | 59 | 8 | 0 | — |
| Domains | 78 root | 0 | 55 | 4 | 0 | — |
| Eating Out | 71 root | 7 | 22 | 585 | 0 | 10 |
| Gas | 77 root | 1 | 37 | 30 | 0 | — |
| Golf | 76 root | 0 | 19 | 15 | **1** | 17 |
| Groceries | 69 root | 6 | 32 | 191 | 0 | 6 |
| Office Equipment | **74 child** | 0 | **14 root** | 3 | 2 | 18 |
| Travel | 73 root | 0 | 6 | 19 | 2 | — |
| Vape | 82 root | 4 | 40 | 17 | 0 | 14 |
| Weed | 80 root | 0 | 20 | 34 | 0 | — |

**Every loser is childless**, so `categories_parent_id_fkey ON DELETE RESTRICT`
never fires and no reparenting is needed.

## 4. Design

### Phase 1 — write path

Under a globally-unique name space (Phase 3) a "path" is a *hint about where a
category belongs*, not an address. `resolveCategoryPath` is rewritten to match:

- resolve each segment by a **household-global** `(householdId, nameKey)`
  lookup;
- reuse whatever it finds, **regardless of that node's parent**, and never
  reparent it;
- create — at the current walk `parentId` — only when the name exists nowhere in
  the household.

So `resolveCategoryPath("Ai")` returns 28, and
`resolveCategoryPath("Household / Groceries")` returns 32. Neither forks.

`ensureCategory` returns the resolved leaf `{ id, name }` instead of `void`.

`aiBatchOverColdRows.ts` and `embeddingMatchOverColdRows.ts` resolve **before**
the static `Transaction.update` and write both halves of each pair in that one
statement: `finalCategory` = the leaf node's flat `name`, `finalCategoryId` =
the leaf id (same for `autoCategory` / `autoCategoryId`). Path-form strings and
NULL ids stop being produced. The false comment at `:163` is deleted.

`amazon/aiCategorizeAmazonItems.ts:341` gets the same treatment for
`inferredCategory` / `inferredCategoryId`.

`createCategory.ts`, the `PATCH /api/categories/:id` rename check, and
`reparent.ts` move their conflict lookups from parent-scoped to
household-global, with a distinct `name_conflict` error code (409).

`resolveCategoryIdByName` needs no change. Under a global unique its `matches`
array holds 0 or 1 rows, so steps 1 and 2 always decide and the step-3
ambiguity branch becomes unreachable but harmless.

### Phase 2 — the regression test

The deliverable. A colocated unit test carrying a **checked-in snapshot of the
real household-1 shape**: all 80 categories (`id`, `parent_id`, `name`), all 23
`budget_targets` rows, and the distinct `(currency, final_category, sum, count)`
spend buckets for September 2026. No merchants, accounts, or dates.

It asserts, for every budget, that `categoryAndDescendantNames` +
`computeBudgetProgress` produce the same `spent` before and after the merge —
except the three rows pinned below as intended changes.

It also pins the sharp edge found in `reconcileCategoryField.ts:30-32`: setting
`categoryId` to NULL **also nulls the `category` string**. The Golf and Clothing
rows are asserted as `category_id IS NULL AND category = 'Golf' / 'Clothing'`,
and the migration must therefore write them with raw SQL rather than through the
model. The trick survives an amount edit (neither field changed → the hook is a
no-op) but not a re-typed category name, which would re-resolve the string to
the winner id and silently restore the rollup. That hazard already exists for
budgets 7 and 22 and is documented, not fixed, here.

### Phase 3 — the constraint

Drop `categories_household_root_name_key_unique` and
`categories_household_parent_name_key_unique`; add
`categories_household_name_key_unique` on `(household_id, name_key)`.

Budgets and spend rollups already join on the name string, so two same-named
categories anywhere in a household are indistinguishable to every reporting
surface. A global unique makes the constraint match the semantics the reporting
layer has always assumed. Cost: `Transportation / Gas` can never coexist with a
hypothetical `Cottage / Gas`.

Verified safe: across the whole `categories` table there are exactly 15
duplicate `name_key` groups, all of them the pairs above, all in household 1;
no household but 1 has any categories; and no `name_key` maps to more than one
distinct `name`, so there is no case-variant collision waiting.

The migration guards itself: it aborts if any `(household_id, name_key)` group
still has `COUNT(*) > 1` at index-creation time, mirroring
`20260621000001-category-tree-foundation.js:36-45`.

### Phase 4 — the merge

Per pair, loser `L` → winner `W`:

1. `transactions.final_category_id`, `auto_category_id`, `category_override_id`
2. `rules.category_id`
3. `budget_targets.category_id` — **except** budgets 17 (Golf) and 16
   (Clothing), which get `category_id = NULL` with the `category` string left
   intact
4. `income_entries.category_id`
5. `external_order_items.inferred_category_id`, `category_override_id`
6. `DELETE FROM categories WHERE id = L`

### Phase 5 — the data repair

Both parts apply to all three transaction pairs — `final_category` /
`final_category_id`, `auto_category` / `auto_category_id`, and
`category_override` / `category_override_id` — plus
`external_order_items.inferred_category` / `category_override` and their ids.
The counts below are for `final_category`, the column every budget and spend
rollup reads; the script reports the other columns' counts at run time.

**(a) 2,804 flat-name rows, 20 names — id fill only, zero budget delta.** The
string is untouched, so nothing any budget counts changes. After Phase 4 all 20
names resolve to exactly one category (the six ambiguous ones collapse).
Largest: `Transfer` 733, `Groceries` 690, `Other` 382, `Payment` 242,
`Dining` 157, `Uncategorized` 107, `Eating Out` 97, `Transportation` 93.

**(b) 198 path-form rows — string rewritten to the leaf name, id filled.** This
*does* move numbers, because that spend is currently invisible to every budget:
`CAD\0Household / Vape` matches no budget's name set. The leaf segment is
resolved the same way Phase 1 resolves it — a household-global `name_key`
lookup — so the rewrite and the live write path cannot disagree.

## 5. Expected budget delta

Computed against the September 2026 spend buckets. **Phases 1–4 change nothing.**
All three changes come from Phase 5(b):

| budget | before | after | why |
|---|---|---|---|
| 8 Healthcare (350) | 172.13 | **628.65** | `Healthcare / Dentist` → `Dentist` (+252.00), `Healthcare / Diabetes` → `Diabetes` (+204.52); both are in budget 8's subtree |
| 14 Vape (25) | 0.00 | **265.48** | `Household / Vape` → `Vape`; the Vape budget currently reads zero despite four charges |
| 9 Transportation (100) | 27.92 | **31.41** | `Transportation / Gas` → `Gas` (+3.49) |

The other 20 budgets are byte-identical, including every pair-affected one:
cc fees 21.99, Groceries 878.06, Eating Out 17.73, Alcohol 290.90, Clothing
0.00, Golf 0.00, Office Equipment 0.00, Household 793.68, Hobbies 35.69.

`Hobbies / Travel` ($20.23) becomes `Travel`, which feeds no budget — budget 22
`Hobbies` is an exact-name match and there is no Travel budget.

Historical periods move more than the current one: `Hobbies / Golf` $3,371.83
(2022–2024), `Hobbies / Travel` $7,502.15, `Hobbies / Golf / Clublink` $4,952.06
(2025-08-29), `Household / Clothing` $1,512.02, `Hobbies / Racing` $1,417.13.
Those appear in trend views for their own periods, not in the current month.

## 6. Out of scope

- The semantic overlap between `Dining` (budget 11, $50) and `Eating Out`
  (budget 10, $175) — distinct names, not a duplicate. Connor's call, not this
  work's.
- `Household / Beverages` (84) is new from the same run but has no duplicate.
  It stays.
- Adding an explicit `rollup` flag to `budget_targets` so the no-rollup
  intention stops being encoded as a NULL id. The right fix for the sharp edge
  in Phase 2, but it is a spine change and belongs in its own PR.
