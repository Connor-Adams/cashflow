# Dashboard Calendar-Aligned Preset Views Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add calendar-aligned date-range presets (This/Last month, quarter, year) to the dashboard quick-range row and default the dashboard to "This month".

**Architecture:** Three pure, timezone-safe date-math helpers in `frontend/src/lib/dateInput.ts` (following the existing `getRelativeDateRange(days, now=new Date())` injectable-anchor pattern), wired into the `quickRanges` array and default-range function in `DashboardPage.tsx`. No backend, no `FilterBar`, no new components.

**Tech Stack:** React 19 + TypeScript, vitest (frontend tests). Helpers use UTC accessors / `Date.UTC` for month/quarter/year rollover.

Spec: `docs/superpowers/specs/2026-06-15-dashboard-calendar-preset-views-design.md`

---

## Key conventions (from spec)

- **"This X" presets** (`offset === 0`): `from` = period start, `to` = period **end** (last day of month/quarter/year), NOT today. This keeps "This year" distinct from "YTD" so `FilterBar`'s exact-match highlight (`range.from===dateFrom && range.to===dateTo`) doesn't collide.
- **"Last X" presets** (`offset === -1`): the fully completed previous period.
- All helpers anchor on the user's local "today" via `fromDateInputValue(todayDateInputValue(now))!`, exactly like `getRelativeDateRange`, and accept an optional `now: Date = new Date()` for tests.
- `Date.UTC(y, m, d)` normalizes out-of-range months — `Date.UTC(2026, -1, 1)` → `2025-12-01`, `Date.UTC(2026, 12, 0)` → `2026-12-31` — so year rollover is automatic.

## File structure

- **Modify** `frontend/src/lib/dateInput.ts` — add `getCalendarMonthRange`, `getCalendarQuarterRange`, `getCalendarYearRange`.
- **Modify** `frontend/src/lib/dateInput.test.ts` — colocated vitest tests for the three helpers.
- **Modify** `frontend/src/pages/DashboardPage.tsx` — import the three helpers, extend `quickRanges` (10 buttons), repoint `getDefaultDashboardRange` to `getCalendarMonthRange(0)`.

Run a single frontend test file: `yarn workspace frontend run test dateInput`

---

### Task 1: Calendar date-range helpers

**Files:**
- Modify: `frontend/src/lib/dateInput.ts` (append after `getRelativeDateRange`, ~line 96)
- Test: `frontend/src/lib/dateInput.test.ts` (append new `describe` blocks)

- [ ] **Step 1: Write the failing tests**

Append to `frontend/src/lib/dateInput.test.ts` (the file already imports from `./dateInput` at the top — add the three new names to that existing import: `getCalendarMonthRange, getCalendarQuarterRange, getCalendarYearRange`):

```ts
describe('getCalendarMonthRange', () => {
  const jun15 = new Date(Date.UTC(2026, 5, 15)) // 2026-06-15

  it('offset 0 = first..last day of current month', () => {
    expect(getCalendarMonthRange(0, jun15)).toEqual({
      from: '2026-06-01',
      to: '2026-06-30',
    })
  })

  it('offset -1 = previous full month', () => {
    expect(getCalendarMonthRange(-1, jun15)).toEqual({
      from: '2026-05-01',
      to: '2026-05-31',
    })
  })

  it('offset -1 in January rolls back to previous December', () => {
    const jan5 = new Date(Date.UTC(2026, 0, 5))
    expect(getCalendarMonthRange(-1, jan5)).toEqual({
      from: '2025-12-01',
      to: '2025-12-31',
    })
  })

  it('handles leap-year February end date', () => {
    const feb10 = new Date(Date.UTC(2028, 1, 10)) // 2028 is a leap year
    expect(getCalendarMonthRange(0, feb10)).toEqual({
      from: '2028-02-01',
      to: '2028-02-29',
    })
  })
})

describe('getCalendarQuarterRange', () => {
  it('offset 0 in Q2 = Apr 1..Jun 30', () => {
    const may20 = new Date(Date.UTC(2026, 4, 20))
    expect(getCalendarQuarterRange(0, may20)).toEqual({
      from: '2026-04-01',
      to: '2026-06-30',
    })
  })

  it('offset -1 in Q1 rolls back to prior-year Q4', () => {
    const feb10 = new Date(Date.UTC(2026, 1, 10))
    expect(getCalendarQuarterRange(-1, feb10)).toEqual({
      from: '2025-10-01',
      to: '2025-12-31',
    })
  })

  it('offset 0 in Q4 = Oct 1..Dec 31', () => {
    const nov3 = new Date(Date.UTC(2026, 10, 3))
    expect(getCalendarQuarterRange(0, nov3)).toEqual({
      from: '2026-10-01',
      to: '2026-12-31',
    })
  })
})

describe('getCalendarYearRange', () => {
  const jun15 = new Date(Date.UTC(2026, 5, 15))

  it('offset 0 = Jan 1..Dec 31 of current year', () => {
    expect(getCalendarYearRange(0, jun15)).toEqual({
      from: '2026-01-01',
      to: '2026-12-31',
    })
  })

  it('offset -1 = previous full year', () => {
    expect(getCalendarYearRange(-1, jun15)).toEqual({
      from: '2025-01-01',
      to: '2025-12-31',
    })
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `yarn workspace frontend run test dateInput`
Expected: FAIL — `getCalendarMonthRange is not a function` (and the other two).

- [ ] **Step 3: Implement the three helpers**

Append to `frontend/src/lib/dateInput.ts`:

```ts
/**
 * Calendar-month range. `offset` 0 = current month, -1 = previous month.
 * `from` is the 1st; `to` is the LAST day of the (offset-adjusted) month —
 * NOT "today". Period-end `to` keeps "This year" distinct from "YTD" so the
 * FilterBar exact-match highlight doesn't collide. `Date.UTC` normalizes
 * negative/overflow months, giving automatic year rollover.
 *
 * Optional `now` argument is for tests.
 */
export function getCalendarMonthRange(
  offset: number,
  now: Date = new Date()
): { from: string; to: string } {
  const today = fromDateInputValue(todayDateInputValue(now))!
  const year = today.getUTCFullYear()
  const month = today.getUTCMonth() + offset
  const from = new Date(Date.UTC(year, month, 1))
  const to = new Date(Date.UTC(year, month + 1, 0))
  return { from: toDateInputValue(from), to: toDateInputValue(to) }
}

/**
 * Calendar-quarter range. `offset` 0 = current quarter, -1 = previous.
 * Quarters start at month 0/3/6/9; `to` is the last day of the quarter.
 *
 * Optional `now` argument is for tests.
 */
export function getCalendarQuarterRange(
  offset: number,
  now: Date = new Date()
): { from: string; to: string } {
  const today = fromDateInputValue(todayDateInputValue(now))!
  const year = today.getUTCFullYear()
  const quarterStartMonth = Math.floor(today.getUTCMonth() / 3) * 3 + offset * 3
  const from = new Date(Date.UTC(year, quarterStartMonth, 1))
  const to = new Date(Date.UTC(year, quarterStartMonth + 3, 0))
  return { from: toDateInputValue(from), to: toDateInputValue(to) }
}

/**
 * Calendar-year range. `offset` 0 = current year, -1 = previous.
 * `from` is Jan 1, `to` is Dec 31 of the (offset-adjusted) year.
 *
 * Optional `now` argument is for tests.
 */
export function getCalendarYearRange(
  offset: number,
  now: Date = new Date()
): { from: string; to: string } {
  const today = fromDateInputValue(todayDateInputValue(now))!
  const year = today.getUTCFullYear() + offset
  const from = new Date(Date.UTC(year, 0, 1))
  const to = new Date(Date.UTC(year, 11, 31))
  return { from: toDateInputValue(from), to: toDateInputValue(to) }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `yarn workspace frontend run test dateInput`
Expected: PASS — all new tests green, existing dateInput tests still green.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/dateInput.ts frontend/src/lib/dateInput.test.ts
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH git commit -m "feat(dashboard): add calendar month/quarter/year date-range helpers"
```

---

### Task 2: Wire calendar presets into the dashboard

**Files:**
- Modify: `frontend/src/pages/DashboardPage.tsx` — import block (~line 44-49), `getDefaultDashboardRange` (~line 215), `quickRanges` useMemo (~line 628)

> No new unit test: `quickRanges` is a presentational `useMemo` and the date math is already covered by Task 1. Verification is the typecheck + a manual smoke at the end.

- [ ] **Step 1: Import the three helpers**

In `frontend/src/pages/DashboardPage.tsx`, extend the existing `../lib/dateInput` import (currently `fromDateInputValue, getRelativeDateRange, toDateInputValue, todayDateInputValue`) to also include the calendar helpers:

```ts
import {
  fromDateInputValue,
  getCalendarMonthRange,
  getCalendarQuarterRange,
  getCalendarYearRange,
  getRelativeDateRange,
  toDateInputValue,
  todayDateInputValue,
} from '../lib/dateInput'
```

- [ ] **Step 2: Repoint the default range to "This month"**

Replace the body of `getDefaultDashboardRange` (~line 215):

```ts
function getDefaultDashboardRange(): { from: string; to: string } {
  return getCalendarMonthRange(0)
}
```

(`getRelativeDateRange` is still imported — it remains in use by `getDefaultDashboardRange`'s neighbors elsewhere? No: confirm with a grep in Step 4. If it becomes unused, remove it from the import to keep lint clean.)

- [ ] **Step 3: Extend the quickRanges array**

Replace the `quickRanges` useMemo (~line 628) with the 10-button set, calendar-first then rolling:

```ts
  const quickRanges = useMemo<QuickRange[]>(
    () => [
      { key: 'month', label: 'This month', ...getCalendarMonthRange(0) },
      { key: 'lastMonth', label: 'Last month', ...getCalendarMonthRange(-1) },
      { key: 'quarter', label: 'This quarter', ...getCalendarQuarterRange(0) },
      {
        key: 'lastQuarter',
        label: 'Last quarter',
        ...getCalendarQuarterRange(-1),
      },
      { key: 'year', label: 'This year', ...getCalendarYearRange(0) },
      { key: 'lastYear', label: 'Last year', ...getCalendarYearRange(-1) },
      { key: '3m', label: '3 months', ...getRollingMonthRange(3) },
      { key: '6m', label: '6 months', ...getRollingMonthRange(6) },
      { key: 'ytd', label: 'YTD', ...getYearToDateRange() },
      { key: 'all', label: 'All time', from: '', to: '' },
    ],
    []
  )
```

- [ ] **Step 4: Typecheck + lint + verify getRelativeDateRange usage**

Run:
```bash
grep -n 'getRelativeDateRange' frontend/src/pages/DashboardPage.tsx
yarn workspace frontend run lint
yarn workspace frontend run build
```
Expected: if the grep shows `getRelativeDateRange` is no longer referenced in `DashboardPage.tsx`, remove it from the `../lib/dateInput` import (Step 1) before linting. Lint clean (no unused-import error), build succeeds.

- [ ] **Step 5: Manual smoke**

Run: `yarn dev`, open `http://localhost:5173`, go to the dashboard.
Expected:
- On load, the date inputs show the 1st → last day of the current month, and the **This month** button is highlighted (`aria-pressed`).
- Clicking **Last month**, **This quarter**, **Last quarter**, **This year**, **Last year** updates From/To to the correct calendar boundaries and highlights the clicked button.
- The row wraps to a second line if it doesn't fit; existing rolling buttons (3 months, 6 months, YTD, All time) still work.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/pages/DashboardPage.tsx
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH git commit -m "feat(dashboard): add calendar-aligned quick-range presets, default to this month"
```

---

## Self-review

- **Spec coverage:** 3 helpers (Task 1) ✓; "this X" = period-end convention encoded in helper bodies + comments ✓; 10-button quickRanges in spec order (Task 2 Step 3) ✓; default → This month (Task 2 Step 2) ✓; colocated boundary tests incl. Jan rollover, Q1→prior-Q4, leap Feb (Task 1 Step 1) ✓; FilterBar/layout unchanged, wrap handled by existing `.quickFilters` ✓.
- **Placeholder scan:** no TBD/TODO; all code shown in full.
- **Type consistency:** helper signatures `(offset: number, now?: Date) => { from: string; to: string }` identical across Task 1 def, Task 1 tests, Task 2 usage; `QuickRange` keys unique.
- **Deviation from spec:** spec said "add helpers beside `getRollingMonthRange` in DashboardPage"; plan puts them in `lib/dateInput.ts` instead, because that file already has the injectable-`now` pattern + colocated vitest file the spec's own testing section requires. `getRollingMonthRange`/`getYearToDateRange` stay in DashboardPage (YAGNI — not moving them).
