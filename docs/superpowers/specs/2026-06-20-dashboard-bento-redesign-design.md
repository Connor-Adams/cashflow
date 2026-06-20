# Dashboard Bento Redesign — Design

**Status:** Approved (brainstorming) — 2026-06-20

## Goal

Give `DashboardPage` the visible "new look" the Cashflow Design System carries:
rebuild its layout to match the DS reference design
(`cashflow-design-system` → `ui_kits/cashflow-app/DashboardScreen.jsx`), a
responsive **12-column bento grid**, while preserving every piece of the current
dashboard's real data, multi-currency/period logic, and features.

This is a **presentation/layout redesign**, not a data change. It builds on the
completed `@cashflow/ui` → `@connor-adams/designsystem` migration (PR #924): the
dashboard now renders DS primitives; this redesign arranges them into the bento.

## Context

- Current `frontend/src/pages/DashboardPage.tsx` (~1523 lines): ~280 lines of data
  fetching/state (dashboard summary, monthly, period insight, budget progress,
  recurring, merchant/account/review summaries; multi-currency; previous-period
  deltas) + ~1200 lines of render.
- DS reference (`DashboardScreen.jsx`, 196 lines): a curated bento — KPI stat row,
  review banner, net-spend-by-category bars, an Activity KPI panel, income & spend
  business/personal split panels, and a budget-pacing strip. Mock data, inline
  styles.

## Decisions (from brainstorming)

1. **Hybrid scope.** Adopt the mockup's bento up top; **keep** the current
   merchant-summary, account-summary, and review-queue tables as additional bento
   tiles below. Nothing is dropped from the dashboard.
2. **Tailwind + DS primitives.** Build the grid/panels with Tailwind utilities
   (per `docs/ui-rules.md`), using DS components for the pieces. Not inline styles.
3. **Activity tile populated** from existing fetched data (not dropped, not mock).

## Layout & tile map

A `grid grid-cols-1 md:grid-cols-12 gap-4` bento. Spans apply at `md:` and up;
everything stacks to one column below `md`.

| Tile | md span | Component | Data source (existing) |
|---|---|---|---|
| Page header | — | current `PageHeader` | "Dashboard" + subtitle (unchanged) |
| Filter strip | full | new `DashboardFilterStrip` | current currency/period state |
| KPI stat row | 4 ea (×3) | DS `StatCard` | dashboard summary metrics + prev-period deltas |
| Review banner | 12 | DS `Alert` + `Button` | review-queue count; dismiss logic preserved |
| Net spend by category | 7 | new `CategoryBars` | category reports; bar click → transactions |
| Activity | 5 | new `ActivityPanel` | `transactionCount` + derived monthly/insight KPIs |
| Income · business vs personal | 6 | new `SplitPanel` | business-focus income split |
| Spend · business vs personal | 6 | new `SplitPanel` | business-focus spend split |
| Budget progress + pacing | 12 | new `BudgetPill` strip | `budgetProgress` |
| Merchant summary | 6 | current `TableTile` | merchant summaries |
| Account summary | 6 | current `TableTile` | account summaries |
| Review queue | 12 | current `TableTile` | review queue rows |

The review queue appears **both** as the banner (count + CTA) and the table
(hybrid) — matching today's behavior plus the mockup's banner.

## Component structure

Keep `DashboardPage.tsx` as the **data + orchestration container** (data layer
unchanged); extract the bento tiles into small, testable components under
`frontend/src/components/dashboard/`:

- `Panel` — Card-based bento panel wrapper (border, `bg-card`, shadow, padding,
  `h-full`). Props: `className`, `children`.
- `PanelHead` — title + optional icon + optional description.
- `SplitPanel` — business/personal split: two `FocusCard`s + a proportion bar.
  Props: `title`, `icon`, `business`/`personal` values + percentages.
- `FocusCard` — single business or personal figure with toned border.
- `BudgetPill` — one budget's progress bar + pacing tick + spent/target. Props:
  the existing `BudgetProgress` row shape.
- `CategoryBars` — the net-spend-by-category bar list; each row a
  `CategoryPill` + proportional bar + `AmountText`, click → transactions.
- `ActivityPanel` — KPI rows (label/hint/value/optional delta).
- `DashboardFilterStrip` — currency chip + active-period chip + quick-range
  buttons + "Showing <currency> · <period>" pill, wired to existing handlers.

DS finance primitives newly adopted here: `CategoryPill`, `AmountText` (already
exported from `@connor-adams/designsystem`).

## Authoring rules

- Tailwind utilities for layout/spacing/color (token utilities only, no hex).
- DS primitives for components; Tailwind `grid` + `Panel` for the bento.
- Color-mix backgrounds the DS uses (e.g. toned `FocusCard` borders) stay as
  small inline `style` only where a Tailwind utility can't express `color-mix`
  with a token — mirroring how the existing dashboard already handles budget-pill
  fills.
- Responsive: `grid-cols-1 md:grid-cols-12`; horizontal-scroll strip for budgets.

## Activity tile contents

Populated from data already fetched — no new endpoints. KPI rows drawn from:
`transactionCount` (this period), and period-over-period figures already computed
for the deltas (e.g. count vs previous, net change). Exact metric selection is a
plan detail; the tile renders 3–4 KPI rows in the mockup's label/hint/value/delta
shape. If a metric isn't available without new fetching, it is omitted (the panel
sizes to whatever KPIs exist) rather than mocked.

## What is preserved (non-negotiable)

- All data fetching, state, multi-currency + period filtering, previous-period
  delta computation, banner-dismissal persistence, and the three summary tables.
- All navigation/click behaviors (category → transactions, review → open review).
- The page's existing characterization test stays green.

## Testing

- A render test per extracted tile component (renders with representative props;
  asserts key content + that click handlers fire where applicable).
- Keep `DashboardPage`'s existing test passing (header, key rows, columns).

## Out of scope

- Other pages (dashboard first; roll-out is a later, separate effort).
- Data-layer / API changes.
- Re-authoring the DS itself.
