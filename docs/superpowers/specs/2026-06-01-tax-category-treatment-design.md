# Tax category treatment — design

**Date:** 2026-06-01
**Status:** Approved (pending spec review)

## Problem

The personal T1 engine sources transaction-based income and deductions by
exact-matching `Transaction.finalCategory` against four hardcoded constants:
`employment_income`, `donations`, `rrsp_contribution`, `fhsa_contribution`
(`buildPersonalFacts.ts`, the per-transaction loop). But the `Category` model is
free-form (`{ householdId, name, icon }`) with no tax semantics, and
`finalCategory` only ever holds a human label (`Groceries`, `Payment`,
`Investment income`). The categorizer/enrichment pipeline and UI never emit those
snake_case strings, and there is no mapping layer.

Consequence: those four engine branches are dead code for real data. A
`+$51,165.90` transaction categorized `Payment` is invisible to every return.
Verified in prod: 0 transactions match any of the four constants.

This spec adds a bridge between the free-form category taxonomy and tax
semantics, with a per-transaction override for cases where a category is too
coarse (e.g. a vague `Payment` category that is not uniformly employment income).

## Goals

- A category can declare a tax treatment that flows into the personal T1.
- An individual transaction can override its category's treatment.
- The engine consumes the resolved treatment instead of matching magic strings.

## Non-goals

- No new tax treatments beyond the four the engine already computes. Adding
  medical/tuition/childcare etc. requires new engine logic and is a separate
  feature.
- Self-employment stays the existing per-transaction `finalBusiness` boolean. It
  is orthogonal (a transaction has a category *and* a business flag) and is not
  folded into tax treatment.
- No slip auto-entry, no new credits, no bulk re-categorization tooling.

## Tax treatment vocabulary

A single closed set, shared between backend and frontend via `@cashflow/shared`
(mirroring the existing `isCategoryIconName` helper):

```
type TaxTreatment =
  | 'none'              // default — not tax-relevant
  | 'employment_income'
  | 'donations'
  | 'rrsp_contribution'
  | 'fhsa_contribution';
```

Export `TAX_TREATMENTS` (the array) and `isTaxTreatment(x): x is TaxTreatment`.

## Data model

- **`Category.taxTreatment`** — `STRING(32)`, `allowNull: false`, default `'none'`.
  The category-level default.
- **`Transaction.taxTreatmentOverride`** — `STRING(32)`, `allowNull: true`. A
  per-transaction override; `null` means "use the category default".

Both validated against `isTaxTreatment` at the API boundary (the DB column stays
a plain string for forward-compatibility, matching how `finalCategory` /
`activityType` are stored).

### Migration

One migration adds both columns:
- `categories.tax_treatment` NOT NULL default `'none'`.
- `transactions.tax_treatment_override` nullable.

No data backfill — existing rows resolve to `none`.

## Resolution (live, in the builder)

Resolution happens inside `buildPersonalFacts`, not as a stored `final*` column.
Rationale: only the tax builder consumes the treatment, and storing a
`finalTaxTreatment` would require recomputing every transaction in a category
whenever that category's treatment changes. Live resolution is always correct
with no backfill.

`buildPersonalFacts` already loads the `entity` (hence `householdId`). Add:

1. Load the household's categories once:
   `Category.findAll({ where: { householdId: entity.householdId } })` →
   `Map<name, taxTreatment>` (the `catTreatment` map).
2. For each transaction:
   ```
   treatment = t.taxTreatmentOverride ?? catTreatment.get(t.finalCategory ?? '') ?? 'none'
   ```
3. Replace the four `cat === '<const>'` checks with `treatment === '<const>'`.

The `finalBusiness` branches (self-employment income/expenses) are unchanged.

`t1.ts` is unchanged: employment income from a category still defers to T4
box-14 totals when a T4 slip exists (slip-preferred path preserved).

## API

- **`PATCH /categories/:id`** (`routes/categories.ts`): additionally accept an
  optional `taxTreatment` field. Validate with `isTaxTreatment`; reject unknown
  values with 400. The existing `icon` handling is unchanged; `taxTreatment` is
  independently optional (the current "`icon` field required" guard must not
  reject a `taxTreatment`-only patch — relax it to "at least one of `icon`,
  `taxTreatment`").
- **Transaction override**: `PATCH /transactions/:id` (`routes/transactions.ts`,
  handler at ~line 1091) accepts overrides via the `PATCHABLE_KEYS` allow-list
  (~line 353, alongside `categoryOverride` / `businessOverride`). Add
  `taxTreatmentOverride` to that list (`null` to clear). Validate with
  `isTaxTreatment` when non-null.

## UI

- **`CategoriesTab`** (`pages/settings/tabs/CategoriesTab.tsx`): a per-category
  treatment dropdown — `Default (none) / Employment income / Donation / RRSP
  contribution / FHSA contribution` — persisting via the categories PATCH.
- **Transaction edit** (wherever `businessOverride` / `categoryOverride` are
  set): a `taxTreatmentOverride` selector — `Use category default` plus the four
  treatments — persisting via the transaction PATCH.

## Testing (TDD)

- **Builder** (`buildPersonalFacts.test.ts`):
  - A category with `taxTreatment='employment_income'` makes its transactions
    appear as employment income.
  - `taxTreatmentOverride` on a transaction beats its category's default.
  - An override on a `none` category is honored.
  - A `donations` category populates `facts.donations`; `rrsp_contribution` /
    `fhsa_contribution` populate their respective contributions.
- **Categories route** (`routes-*` test): PATCH sets `taxTreatment`; an invalid
  value is rejected 400; a `taxTreatment`-only patch (no `icon`) succeeds.
- **Transaction route**: PATCH sets and clears `taxTreatmentOverride`; invalid
  rejected.
- **UI**: `CategoriesTab.test` — the dropdown renders and persists.

## Out of scope

Slip auto-entry; additional tax treatments / credits; bulk re-categorization;
any change to corp facts (`buildCorpFacts`) — corp uses `finalBusiness` for
active business income and does not consume these transaction categories.
