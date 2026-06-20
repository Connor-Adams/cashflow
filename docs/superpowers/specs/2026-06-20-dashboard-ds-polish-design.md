# Dashboard DS Polish — Design

**Status:** Approved (brainstorming) — 2026-06-20 (revised: scope corrected after
discovering the dashboard is already a bento grid)

## Why this scope (corrected)

The original brief — "redesign the dashboard into the DS bento grid" — turned out
to be **already done**: `DashboardPage.tsx` is already a 12-col `BentoTile`/
`TableTile` bento, and the DS `DashboardScreen.jsx` mockup was modeled on it. So
there is no "new look" to switch on. The honest, no-regression improvement is
**incremental polish**: adopt the specific DS treatments where the dashboard still
diverges, and remove the legacy CSS that remains.

A full survey found that almost everything already uses Tailwind + DS-style
components (`KpiStack` is clean Tailwind; budget pills are Tailwind with minimal
inline `color-mix`; the three tables are `TableTile`). The **only** render section
still on **legacy `App.css` classes** is the business-vs-personal split. That is
this project's target.

Explicitly **out of scope** (and why):
- DS `StatCard` for the KPI tile — `KpiStack` is already clean Tailwind; swapping
  is cosmetic-only and changes the stacked layout. Not worth it now.
- DS `BudgetMeter` for budget pills — it has no pacing tick / pacing-state badge,
  so adopting it would **lose features**. Keep the current pills.
- Category Recharts chart → CSS bars — the interactive chart works; converting it
  is a feature trade, not polish.
- Filter-strip restyle — deferred; not on legacy CSS, lower value.

## Goal

Replace the two business-vs-personal blocks in `DashboardPage` (income split +
spend split, currently on legacy `App.css` classes) with a Tailwind + DS-primitive
`SplitPanel` component, and delete the now-unused legacy CSS. No data or behavior
change.

## Current state

`DashboardPage.tsx` lines 1083–1177 render two near-identical blocks using legacy
classes defined in `App.css` lines 858–918: `businessSpotlightGrid`,
`businessFocusCard` (+ `--business` / `--personal`), `businessSharePanel`,
`businessShareLabels`, `businessShareBar`, `businessShareFill` (+ `--business` /
`--personal`), `businessShareCaption`. Both blocks derive from the `bizSplit` memo:

```ts
// from frontend/src/lib/businessIncomeSpend.ts
type BusinessIncomeSpend = {
  income: { business: number; personal: number }
  spend:  { business: number; personal: number }
  incomeShare: number  // 0-100, clamped, div-by-zero safe
  spendShare:  number
}
```

Income block: `Wallet` icon, values `bizSplit.income.{business,personal}`, share
`bizSplit.incomeShare`, empty caption "No income in current filters." Spend block:
`ShoppingBag` icon, `bizSplit.spend.*`, `bizSplit.spendShare`, empty caption "No
net spend in current filters."

## Design

A new `frontend/src/components/dashboard/SplitPanel.tsx` exporting `SplitPanel`,
rendered inside the existing two `BentoTile`s (the tiles, icons, labels, and
descriptions stay where they are in `DashboardPage`).

```tsx
type SplitPanelProps = {
  /** Two toned figures, business first. */
  business: number
  personal: number
  /** 0-100, business' share of the total (from bizSplit.{income,spend}Share). */
  businessShare: number
  /** Currency for AmountText (empty string → unstyled number, matching today). */
  currency: string
  /** Shown when business+personal <= 0. */
  emptyCaption: string
}
```

Internals (Tailwind + DS, mirroring the DS mockup's `FocusCard` + share bar):
- Two `FocusCard`s in a `grid grid-cols-2 gap-3.5`: each a rounded card with a
  toned border (`color-mix` of `--chart-business` / `--positive` with `--border`),
  an uppercase label, and the figure via DS `AmountText`
  (`<AmountText value={n} currency={currency} colored={false} decimals={0} />` —
  `colored={false}` keeps today's neutral look; when `currency` is empty, omit it
  so `AmountText` falls back to a plain number).
- A labels row (`Business {share}%` / `Personal {100-share}%`).
- A proportion bar: `flex h-3.5 rounded-md overflow-hidden border`, with a
  `--chart-business` fill at `businessShare%` and a `--positive` fill at the
  remainder. `role="img"` + the existing aria-label text.
- The empty caption when `business + personal <= 0`.

The toned `color-mix` borders/fills stay as small inline `style` (a token
`color-mix` Tailwind can't express), exactly as the budget pills already do.

`FocusCard` is a private helper inside the same file (not separately exported) —
it has no other consumer.

## DashboardPage change

Replace each of the two legacy blocks (1083–1129, 1131–1177) with:

```tsx
<SplitPanel
  business={bizSplit.income.business}
  personal={bizSplit.income.personal}
  businessShare={bizSplit.incomeShare}
  currency={displayCurrency}
  emptyCaption="No income in current filters."
/>
```
…and the spend equivalent (`bizSplit.spend.*`, `bizSplit.spendShare`, "No net
spend in current filters."). The enclosing `BentoTile` (icon/label/description)
is unchanged.

## App.css cleanup

Delete `App.css` lines 858–918 (the 11 `business*` classes above). Verify nothing
else references them: `grep -rn "businessFocusCard\|businessShare\|businessSpotlight" frontend/src`
returns only the deleted block after the change.

## Testing

- `SplitPanel.test.tsx`: renders both figures + the share labels; renders the
  empty caption when `business + personal <= 0`; the proportion bar carries the
  business-share width.
- Keep `DashboardPage`'s existing characterization test green.

## Out of scope

Other pages; data/API changes; the deferred items listed above.
