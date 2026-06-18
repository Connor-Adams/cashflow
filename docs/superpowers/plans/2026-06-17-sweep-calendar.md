# CalendarPage Sweep Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]` checkboxes.

**Goal:** UI sweep of `frontend/src/pages/CalendarPage.tsx` (918 lines; 22 inline styles, generic legacy classes) — de-drift the 19 static inline styles to token utilities, migrate `.row`/`.muted`/borrowed `.accounts*` classes, and adopt the DS primitives (Card, SectionHeader, Grid, StatCard, Alert). Guarded by a new characterization test. The 3 dynamic calendar-cell inline styles stay inline.

**Architecture:** Pure frontend. The page already uses Card/Dialog/EmptyState/Badge/Button/Tabs/PageHeader. The remaining drift is in the month-grid/list/summary views + a few generic classes. The calendar grid's computed cell styling (grid template, today-outline, out-of-month opacity) stays inline — it's data/state-driven.

**Tech Stack:** React 19, Tailwind v4, vitest. References (merged): the SavingsRate/LifestyleInflation sweeps; Grid/SectionHeader/StatCard primitives; `docs/ui-rules.md`.

## Global Constraints
- Run from repo root: `/Users/connoradams/Developer/cashflow/.claude/worktrees/sweep-calendar` (node_modules symlinked — `yarn workspace frontend run test` works).
- Commit husky workaround, exact prefix: `PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH git commit -m "…"` (if `-m` blocked, `git commit --file=<tmpfile>`). Sole author — NEVER add Co-Authored-By.
- Color = tokens only: no hex; map each dropped class to its ACTUAL App.css rule (grep — don't trust quotes); no `var(--)` in inline styles EXCEPT the 3 dynamic calendar-cell ones.
- De-drift is look-preserving; SectionHeader/StatCard adoption are deliberate standardizations — note them.
- Every task ends green on the characterization test (Task 1) + `yarn workspace frontend run lint`.

## Scope
- **KEEP inline (DYNAMIC, 3):** the month-grid root (`display:'grid', gridTemplateColumns:'repeat(7,1fr)', gap:'1px', background:'var(--border)'`, ~741), the cell `opacity: cell.inMonth ? 1 : 0.45` (~769), the cell `outline: cell.isToday ? '2px solid var(--primary…)' : 'none'` (~778). These are computed/conditional calendar layout — leave them. (If a cell `style` object MIXES static props with the dynamic one, split: move the static props to className, keep only the dynamic prop in `style`.)
- **Keep:** `.page` wrapper.
- **Migrate the 19 static inline styles** → Tailwind token utilities (flex/gap/margin/padding/border-bottom/text-align/min-width/typography). The static parts of the weekday-header (~748) and cell (~767-780) style objects → className; keep only the dynamic props inline.
- **Generic classes:** `.row` (×6, App.css `mb-3 flex flex-wrap items-center gap-3`) → that utility string; `.muted` (×9) → `text-sm leading-6 text-muted-foreground` (margins per context); the `.error`/padded error alert (~441) → `<Alert variant="error">` if it's a raw error display.
- **Borrowed cross-page classes (fix the coupling):** `.accountsFormCard` (×3, `@apply mb-4`) on `<Card>` → drop the class, use `<Card className="mb-4">`; `.accountsCardHeader` (×1, the UpcomingSummaryCard header) → `<SectionHeader>`.
- **Adopt Grid + StatCard:** the UpcomingSummaryCard 14-day stats row (custom `Stat` divs in a flex row, ~683) → `<Grid minItemWidth={…} gap="…">` of `<StatCard>`s (pick minItemWidth to match the current tile width; deliberate standardization — note it). If the stats row is a simple 3-up flex that StatCard+Grid would visually disrupt, convert the `Stat` tiles to StatCard but keep the existing flex/Grid wrapper that best preserves layout — use judgment, report what you chose.

---

### Task 1: Characterization test (safety net)

No `CalendarPage.test.tsx` exists. Lock behavior first.

**Files:** Create `frontend/src/pages/CalendarPage.test.tsx`

- [ ] **Step 1: Write the test**

The page fetches `/api/calendar/events?...` and `/api/accounts` via `getJson`, and uses `useNavigate` (→ needs `<MemoryRouter>`). Mirror a merged page test harness (`SavingsRatePage.test.tsx`): `vi.mock('../lib/api')` (getJson returns calendar events for the current month + an accounts list; postJson/putJson/deleteReq stubbed), `import React`, `<ToastProvider>`, `<MemoryRouter>`. Read the response types + the events endpoint shape.
Assert stable behavior (roles/text only): the h1 heading (read exact title), the month/list view tabs (or the current month heading), and one rendered event or the 14-day summary label. ~3-4 assertions. The month heading is date-dependent — if so, assert on a stable element (the "Month"/"List" tab, the page title, a summary stat label) rather than a specific month string, OR mock the date. Keep it robust.

- [ ] **Step 2: Run green against the UNMODIFIED page** — `yarn workspace frontend run test CalendarPage` → PASS. Fix mock to match reality if needed.

- [ ] **Step 3: Commit**
```bash
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH git commit -am "test(calendar): characterization test before UI sweep"
```

---

### Task 2: De-drift + primitive adoption

Several focused commits, each keeping the Task 1 test green (run `yarn workspace frontend run test CalendarPage` after EACH).

**Files:** Modify `frontend/src/pages/CalendarPage.tsx`

- [ ] **Step 1: Static inline styles → Tailwind utilities** (commit `refactor(calendar): static inline styles -> token utilities`)

Convert the 19 static inline styles (grep `style={{`). Map flex/gap/margin/padding/border-bottom/text-align/min-width/typography to utilities (e.g. `{flexWrap:'wrap',gap:'0.75rem',marginBottom:'1rem'}`→`flex flex-wrap gap-3 mb-4`; `{minWidth:'8rem',textAlign:'center'}`→`min-w-32 text-center`; `{borderBottom:'1px solid var(--border)',paddingBottom:'0.5rem'}`→`border-b border-border pb-2`; etc.).
For the weekday-header (~748) and calendar-cell (~767-780) style objects: move the STATIC props (`padding`, `background:var(--card)`→`bg-card`, `textAlign`, `fontWeight`, `minHeight`, `display:flex`, `flexDirection`, `gap`, `border:0`, `cursor`) to className; KEEP only the dynamic `opacity`/`outline` (cell) inline. Leave the grid-root (~741) style entirely inline (dynamic).

- [ ] **Step 2: Generic + borrowed classes → tokens/primitives** (commit `refactor(calendar): .row/.muted/.accounts* use tokens + Card/SectionHeader`)

- `.row` (×6) → `mb-3 flex flex-wrap items-center gap-3` (grep App.css to confirm).
- `.muted` (×9) → `text-sm leading-6 text-muted-foreground` (+ margin per context).
- the padded error alert (~441) → `<Alert variant="error">` if it's a raw error display (import Alert; if it's already structured differently, use judgment).
- `.accountsFormCard` (×3) on `<Card>` → drop the class, `<Card className="mb-4">`.
- `.accountsCardHeader` (×1) → `<SectionHeader title={…} actions?={…} />` (import SectionHeader).

- [ ] **Step 3: Adopt Grid + StatCard for the summary** (commit `refactor(calendar): UpcomingSummaryCard uses Grid + StatCard`)

The UpcomingSummaryCard 14-day inflow/outflow/net stats (custom `Stat` divs, ~683) → `<StatCard>`s in a `<Grid minItemWidth={…} gap="…">` (or keep a flex wrapper if Grid disrupts the 3-up layout — your judgment; preserve the look). Deliberate standardization — note it.

- [ ] **Step 4: Verify after each commit** — test green; `yarn workspace frontend run lint` clean.

---

### Task 3: DoD verification

**Files:** Modify `docs/ui-rules.md` only if a bespoke class needs logging.

- [ ] **Step 1: Verify** (from `frontend/src`):
```bash
grep -c "style={{" pages/CalendarPage.tsx     # expect 3 (the dynamic calendar-cell/grid styles). Confirm each remaining is truly dynamic.
grep -oE 'className="[^"]*(\brow\b|\bmuted\b|\berror\b|accountsFormCard|accountsCardHeader|statCard|tableWrap|\btable\b|emptyState)[^"]*"' pages/CalendarPage.tsx | wc -l   # expect 0
```
`.page` may remain. Any bespoke class the rules don't cover → log in `docs/ui-rules.md` "Rule gaps found during sweep".

- [ ] **Step 2: Full gates** — `yarn workspace frontend run lint` clean; `yarn workspace frontend run test CalendarPage` green; broad `yarn workspace frontend run test --run` green. Commit only if a doc edit was made.

---

## Self-Review
- **Coverage:** char test (T1); 19 static inline → utilities (3 dynamic kept) + `.row`/`.muted`/`.accounts*` → tokens/Card/SectionHeader + Grid/StatCard summary (T2); DoD verify (T3). ✓
- **Cross-page coupling fixed:** CalendarPage no longer borrows AccountsPage's `.accountsFormCard`/`.accountsCardHeader`. ✓
- **Look vs standardize:** de-drift look-preserving; SectionHeader/StatCard adoption deliberate standardizations — noted. ✓
- **Risk:** medium — the calendar-cell style split (static→className, keep dynamic opacity/outline inline) must not break the today-highlight or out-of-month dimming; char test + visual reasoning guard. The summary Grid/StatCard adoption may change the 3-up tile look — implementer uses judgment + reports.
