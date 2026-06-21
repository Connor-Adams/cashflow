# Dashboard calendar-aligned preset views

**Date:** 2026-06-15
**Status:** Approved (brainstorm)

## Problem

The dashboard's quick-range buttons are all *rolling/relative* (3 months, 6
months, YTD, All time) and the default range is the trailing 30 days. There is no
way to snap to a *calendar-aligned* period — "this month", "last month", "this
quarter", etc. — which is the natural way to reason about spend. Connor wants
calendar presets added.

## Scope

Add calendar-aligned date-range presets to the dashboard quick-range row.

- **In scope:** date-math helpers + an extended `quickRanges` array in
  `frontend/src/pages/DashboardPage.tsx`; change the default load range to "This
  month".
- **Out of scope:** named/saved views, currency-bound views, per-tile layout
  changes, period-comparison views, backend changes, `FilterBar` changes, new
  components.

This is variant work on an existing view — no new primitive, no new model, no new
route. Pure frontend.

## Design

### New date-math helpers

Add beside the existing `getRollingMonthRange` / `getYearToDateRange` in
`DashboardPage.tsx`. All anchor on the existing `localTodayUtcMidnight()` so the
derived `YYYY-MM-DD` strings are timezone-stable, and all return
`{ from: string; to: string }` using the existing `toDateInputValue`.

- `getCalendarMonthRange(offset: number)` — `0` = this month, `-1` = last month.
- `getCalendarQuarterRange(offset: number)` — `0` = this quarter, `-1` = last.
- `getCalendarYearRange(offset: number)` — `0` = this year, `-1` = last.

Semantics:

- **`offset === 0` ("this X")**: `from` = period start, `to` = **period end**
  (last day of month / quarter / year), NOT today.
- **`offset === -1` ("last X")**: the fully completed previous period
  (start → end).

### Why "this X" ends at period-end, not today

`FilterBar` highlights the active preset by exact match
(`range.from === dateFrom && range.to === dateTo`). If "This year" ended at today
it would be byte-identical to "YTD", and only the first of the two would ever
highlight — confusing. Ending "this X" at period-end keeps all 10 ranges
distinct. A future-dated `to` is harmless: it imposes no real upper cutoff on data
that doesn't exist yet, and downstream consumers (`transactionsUrl`, summary
query, chart viewport) just pass it through as a filter bound.

### quickRanges array

10 buttons, in this order (calendar-first, rolling-after):

| key        | label         | range                          |
|------------|---------------|--------------------------------|
| `month`    | This month    | `getCalendarMonthRange(0)`     |
| `lastMonth`| Last month    | `getCalendarMonthRange(-1)`    |
| `quarter`  | This quarter  | `getCalendarQuarterRange(0)`   |
| `lastQuarter`| Last quarter| `getCalendarQuarterRange(-1)`  |
| `year`     | This year     | `getCalendarYearRange(0)`      |
| `lastYear` | Last year     | `getCalendarYearRange(-1)`     |
| `3m`       | 3 months      | `getRollingMonthRange(3)`      |
| `6m`       | 6 months      | `getRollingMonthRange(6)`      |
| `ytd`      | YTD           | `getYearToDateRange()`         |
| `all`      | All time      | `{ from: '', to: '' }`         |

Keys must be unique and stable (used for React keys + active-match). The
`quickRanges` `useMemo` stays presentational.

### Default range

`getDefaultDashboardRange()` returns `getCalendarMonthRange(0)` (was
`getRelativeDateRange(30)`). On load the dashboard lands on a calendar month and
the "This month" button is highlighted.

### Layout

10 buttons. `.quickFilters` already flex-wraps, so the row spills onto a second
line on narrow viewports with no layout work.

## Testing

Colocated unit tests (repo convention: `*.test.ts` beside source) for the three
helpers. Boundary cases:

- **Last month across year boundary**: in January, `getCalendarMonthRange(-1)`
  → previous December (`YYYY-12-01` … `YYYY-12-31`, year decremented).
- **Quarter math**: this-quarter start aligns to month 0/3/6/9; last-quarter in Q1
  rolls back to prior-year Q4 (`Oct 1 … Dec 31`).
- **Year math**: this year = `Jan 1 … Dec 31`; last year = previous full year.
- **Leap February**: "this month" in a leap-year February ends on the 29th.

Helpers should be deterministic given a fixed "today" — inject or stub the anchor
(`localTodayUtcMidnight`) so tests don't depend on the real clock.

## Risks

- **Future-dated `to`** for "this X": low risk, passes through as a filter bound.
  Verified consumers (`transactionsUrl`, summary query, chart viewport) treat it
  as an upper bound only.
- **This year vs YTD near-duplicate**: resolved by the period-end convention; the
  two ranges differ (Dec 31 vs today) so both highlight independently.
