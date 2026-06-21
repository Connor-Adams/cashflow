# Tax UI Polish — Design Spec

**Date:** 2026-06-02
**Status:** Approved (design), pending implementation plan
**Scope decision:** Full sweep + restyle-with-headline (NOT full IA redesign)

## Problem

The `/tax` section is functional but dev-grade. The Personal T1 tab (and several
siblings) render backend `Decimal` values as raw strings, producing float
garbage like `28796.51844732000000725`; lay out content with bare
`<table>`/`<ul>`/`<h4>` and dozens of inline `style={{}}` blocks; and expose
debug-y artifacts (raw `computed.totals` key dump, "POST /api/tax/entities"
hints, raw timestamps).

A capable, shared UI kit already exists under `frontend/src/components/ui/`
(`Card`, `CollapsibleCard`, `StatCard`, `MetricStat`, `Table`, `Alert`,
`EmptyState`, `PageHeader`, `Skeleton`, `Badge`) and a shared formatter at
`frontend/src/pages/tax/util/format.ts` (`fmtCurrency`, `fmtPct`, `sumNumeric`,
`numericOrZero`, `parseFinite`). Only `OverviewTab`, `TaxHygieneTab`,
`TaxReserveTab`, and `OwnerCompLeverSurface` use the formatter; `OverviewTab`'s
`IntegratedRateCard` already demonstrates the target look.

## Goal

Bring every dev-grade tax tab up to the standard the kit + `OverviewTab` already
set. **Pure restyle — zero behavior change.** No backend changes, no new
routes, no new primitives.

## Non-goals

- No information-architecture redesign from scratch (that was the rejected
  "Full redesign" option).
- Do NOT fix the pre-existing `ComparisonView` bug where corp scenarios render
  blank because `TOTAL_KEYS` does not match corp total keys. It is a logic bug,
  not a styling one. Flag it; leave it.
- No backend / `Decimal` serialization changes.
- No new charts. The `sparkline` kit exists; adding trend visuals is deferred.

## A. Shared contract

Every tab must obey these rules. This is what keeps a parallel fan-out
consistent — agents implement different files against one contract.

1. **Formatting.** All monetary and percentage values render through
   `fmtCurrency` / `fmtPct` from `frontend/src/pages/tax/util/format.ts`.
   - Forbidden: `String(v)` on a total, `${x.amount}` template interpolation of
     a money value, `parseFloat(...).toFixed(2)`, and any locally-redeclared
     `fmt`/`formatCell`/`formatPct`.
   - Delete and replace the three local re-implementations:
     - `MultiYearCompareCard.tsx` — local `fmt()` (lines ~3–10)
     - `scenarios/ComparisonView.tsx` — local `formatCell()` (line ~60)
     - `scenarios/HouseholdRollupCard.tsx` — local `formatCell`/`formatPct`
       (lines ~170–183)
   - This single rule eliminates the float garbage everywhere.

2. **Headline.** Tabs that surface totals lead with a `StatCard` grid:
   `grid grid-cols-2 gap-3 md:grid-cols-4`, 1–4 of the most decision-relevant
   numbers. `StatCard` props: `{ label, value, hint?, delta?, metricKind? }`.
   - `refundOrOwing` renders with `metricKind` so a refund tones positive and an
     amount owing tones warm.

3. **Sections.** Group content into `Card` / `CollapsibleCard`. Reference-level
   detail (L-code line breakdown, the raw `computed.totals` dump) goes in a
   `CollapsibleCard` with `defaultOpen={false}` and a humanized title — e.g.
   "Return detail (T1 lines)", never "Line breakdown".
   - `CollapsibleCard` props: `{ title, description?, actions?, defaultOpen?,
     children }`.

4. **Tables.** Replace bare `<table>/<thead>/<tbody>/<tr>/<th>/<td>` with the
   kit `Table / TableHeader / TableBody / TableRow / TableHead / TableCell`.
   Money columns: `className="text-right tabular-nums"`.

5. **No inline styles.** Every `style={{}}` becomes Tailwind utilities. Variant
   classes (tone, sign, etc.) come from a lookup table keyed by a literal —
   never string-interpolate a class name (Tailwind JIT needs literal class
   strings present in source).

6. **Warnings / empties / dev text.**
   - Warning lists → `Alert` (warn tone), not a bare `<ul>`.
   - Empty states → `EmptyState`.
   - Humanize developer-facing copy: "(POST /api/tax/entities)" becomes friendly
     empty-state guidance; raw timestamps render via `toLocaleString()` already —
     keep, but label them ("Computed …").

7. **New shared helper — `frontend/src/pages/tax/util/labels.ts`.** Created
   first; every tab depends on it.
   - `TOTALS_LABELS: Record<string, string>` mapping total keys to human labels.
     Seed (extend as needed):
     - `totalIncome` → "Total income"
     - `netIncome` → "Net income"
     - `taxableIncome` → "Taxable income"
     - `federalTax` → "Federal tax"
     - `provincialTax` → "Provincial tax"
     - `cppContrib` → "CPP contributions"
     - `eiPremium` → "EI premiums"
     - `totalPayable` → "Total payable"
     - `refundOrOwing` → "Refund / owing"
     - `netTaxPayable` → "Net tax payable"
   - `humanizeKey(key: string): string` — fallback that splits camelCase and
     title-cases (`smallBusinessDeduction` → "Small business deduction"). Used
     for any key not in `TOTALS_LABELS`, so unmapped corp keys still read well.
   - `labelForTotal(key) = TOTALS_LABELS[key] ?? humanizeKey(key)`.
   - Unit-tested (pure functions).

## B. Per-tab plan

### PersonalT1Tab.tsx (the screenshot — worst offender)
- **Headline cards:** Total payable · Refund/owing (`metricKind`) · Total income
  · Taxable income.
- **Demote:** the `computed.totals` `{String(v)}` `<ul>` dump → a labeled list /
  small grid using `labelForTotal` + `fmtCurrency`, inside a `Card` (or fold
  into the detail collapsible). The `LineBreakdownTable` (L-codes) →
  `CollapsibleCard "Return detail (T1 lines)"`, `defaultOpen={false}`, kit
  `Table`, amount column right-aligned via `fmtCurrency`. Preserve the
  expandable formula/inputs row; format `inputs[].amount` via `fmtCurrency`.
- **Warnings** → `Alert`. **Compare bar** → kit styling, drop the inline
  border/rgba styles. **Override editor** stays (polished separately, see below).
- Kill all ~13 inline styles.

### CorpT2Tab.tsx (second worst, largest file ~589 lines)
- Same shape as Personal T1: headline `StatCard` grid (Net tax payable, Taxable
  income, + key totals), `computed.totals` `String(v)` dump → `labelForTotal` +
  `fmtCurrency`, L-code breakdown → `CollapsibleCard` + kit `Table`.
- Kill the ~20 inline styles and the bare `<table>`.

### scenarios/OverrideEditor.tsx
- Editor (no headline). Bare `<table>` (override list + capital-gains
  disposition sub-table) → kit `Table`. Format displayed amounts via
  `fmtCurrency`. Kill inline styles.

### scenarios/CorpOverrideEditor.tsx
- Editor. Kill ~8 inline styles → Tailwind. Format amounts. Intercorp dividend
  distribution rows → kit `Table` if tabular.

### scenarios/ComparisonView.tsx
- Drop local `formatCell()` → `fmtCurrency`. Multi-column totals table → kit
  `Table`. **Do not** fix the corp-keys-blank bug (out of scope) — leave a
  one-line code comment noting it persists.

### scenarios/HouseholdRollupCard.tsx
- Drop local `formatCell`/`formatPct` → shared. Existing headline (Total
  household tax, joint effective rate) → wrap in `StatCard`s. Per-spouse table →
  kit `Table`.

### MultiYearCompareCard.tsx
- Drop local `fmt()` → `fmtCurrency`. YoY table → kit `Table`. Format negatives
  (refund/owing) consistently through `fmtCurrency` rather than the custom
  `(amount)` paren style.

### ShareholderLoanTab.tsx
- **Headline:** loan balance (`StatCard`) — the recent "show shareholder-loan
  balance" work surfaces this. Format `$loan.amount` via `fmtCurrency`. Loan
  entry table → kit `Table`. Kill inline styles.

### InstalmentTracker.tsx
- `parseFloat(item.amount).toFixed(2)` → `fmtCurrency`. Payment table → kit
  `Table`. Kill inline styles.

### OwnerCompPlannerTab.tsx
- Humanize the "POST /api/tax/entities" dev text → `EmptyState`. Bare `<h2>` →
  `PageHeader`/heading. (Delegates body to `OwnerCompLeverSurface`.)

### scenarios/OwnerCompLeverSurface.tsx
- Already imports the formatter (partial). Complete formatter coverage; rollup
  numbers → `StatCard`s. Kill any inline styles.

### scenarios/ScenarioTree.tsx
- Nav tree. Kill ~2 inline styles → Tailwind. Bare `<ul>` → styled list. Keep
  function (fork/delete/select).

### ReconciliationTab.tsx
- **Headline:** warnings count · findings count (`StatCard`s). Per-category
  finding lists → `Card`s; tabular findings → kit `Table`.

### SlipsTab.tsx + slips/*Form.tsx
- Forms. Format any displayed amounts. Slip list → kit `Table` if tabular. Light
  touch — kit components where bare, no inline styles.

### ClassifyTab.tsx + ClassifyRow.tsx
- Format the amount(s). Kit `Table`/row styling. Keep existing behavior; existing
  `ClassifyTab.test.tsx` must stay green.

### scenarios/YearStripNav.tsx + scenarios/AssumptionsEditor.tsx
- Already mostly Tailwind. Verify formatter use where numeric; no regressions.

### TaxHygieneTab.tsx / TaxReserveTab.tsx
- Already use the formatter. Tidy residual inline styles (~23 / ~33) → Tailwind;
  ensure tables are kit `Table`. Lowest priority.

### Top-level: TaxPage.tsx
- `<header>` inline style → `PageHeader`. Otherwise unchanged.

## C. Verification

- **Behavior-preserving:** all existing tests stay green — especially
  `frontend/src/pages/tax/ClassifyTab.test.tsx` and the kit component tests
  (`metric-stat.test`, `pct-delta-cell.test`, etc.).
- **New regression test:** a Personal T1 totals render test asserting a value
  like `28796.51844732` displays as `$28,796.52` (en-CA grouped, 2 dp), NOT the
  raw float string. Locks the formatting fix against regression.
- **New unit test:** `util/labels.ts` — `labelForTotal` known + fallback cases.
- Type-check, build, lint all clean.
- Visual confirmation via the `/run` skill: screenshot Personal T1 + Corp T2
  before/after.

## D. Implementation shape (for writing-plans)

1. **First, alone:** create `util/labels.ts` + its test (shared dependency).
2. **Then fan out** one agent per tab/cluster — the files are largely disjoint,
   so conflict risk is low. Natural clusters:
   - Personal T1 (`PersonalT1Tab` + `OverrideEditor`)
   - Corp T2 (`CorpT2Tab` + `CorpOverrideEditor`)
   - Scenario shared (`ComparisonView`, `HouseholdRollupCard`, `MultiYearCompareCard`, `ScenarioTree`)
   - Owner comp (`OwnerCompPlannerTab` + `OwnerCompLeverSurface`)
   - Ledger-ish (`ShareholderLoanTab`, `InstalmentTracker`, `ReconciliationTab`)
   - Slips/Classify (`SlipsTab` + forms, `ClassifyTab` + row)
   - Cleanup (`TaxHygieneTab`, `TaxReserveTab`, `YearStripNav`, `AssumptionsEditor`, `TaxPage`)
3. Each agent follows the §A contract + its §B entry, runs type-check/build/its
   tests before returning.
4. Integrate, run the full suite, visual check, single PR.

## Acceptance criteria

- No raw `Decimal`/float strings visible anywhere under `/tax`. Grep:
  no `String(` on a total, no `${...amount}` money interpolation, no
  `parseFloat(...).toFixed`, no local `fmt`/`formatCell`/`formatPct` in tax.
- Every former bare `<table>` in tax uses the kit `Table`.
- Zero `style={{}}` remaining in the tax pages (Tailwind only).
- Personal T1 and Corp T2 lead with a `StatCard` headline grid; L-code detail is
  collapsible and humanized.
- All existing tests green; new label + formatting tests added and green.
- Behavior unchanged (scenarios still fork/compare/project; overrides still
  patch; etc.).
