# LifestyleInflationPage Sweep Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]` checkboxes.

**Goal:** Full UI sweep of `frontend/src/pages/LifestyleInflationPage.tsx` (464 lines; drift-rank #2: ~26 inline styles, generic legacy classes) — de-drift to token utilities AND adopt the design-system primitives (Grid, StatCard, SectionHeader, Alert, Card, Table, EmptyState). Guarded by a new characterization test. ~7 dynamic inline styles (computed/conditional colors + conditional margins) stay inline.

**Architecture:** Pure frontend. This page mirrors the just-merged SavingsRatePage shape (filter card, GrowthStat tiles, CurrencyTrendCard, CategoryDrivers, MonthlySeriesTable) — use the merged SavingsRatePage sweep as the worked example.

**Tech Stack:** React 19, Tailwind v4, vitest. References (merged): SavingsRatePage sweep; Grid/SectionHeader/StatCard/Alert/EmptyState/Table primitives; `docs/ui-rules.md`.

## Global Constraints
- Run from repo root: `/Users/connoradams/Developer/cashflow/.claude/worktrees/sweep-lifestyle-inflation` (node_modules symlinked — `yarn workspace frontend run test` works).
- Commit husky workaround, exact prefix: `PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH git commit -m "…"` (if `-m` blocked, `git commit --file=<tmpfile>`). Sole author — NEVER add Co-Authored-By.
- Color = tokens only: no hex; map each dropped class to its ACTUAL App.css rule (grep — don't trust quotes); no `var(--)` in inline styles EXCEPT the dynamic conditional colors.
- De-drift is look-preserving; StatCard/SectionHeader/Alert adoption are deliberate standardizations toward the DS — note them.
- Every task ends green on the characterization test (Task 1) + `yarn workspace frontend run lint`.

## Scope
- **Keep inline (DYNAMIC, ~7):** the `GrowthStat` computed delta `color` (line ~271, derived from delta sign + invert flag); the category-delta `var(--danger)` span (~310) — actually static red, but acceptable to keep OR move to `text-danger`; the conditional negative-savings color in the monthly table (`m.savings < 0 ? 'var(--danger)' : undefined`, ~352); the conditional render margins (~99, ~171). For any that are STATIC single-property (e.g. a bare `text-right` or static `var(--danger)`), prefer moving to a token class (`text-right`, `text-danger`); keep ONLY the genuinely computed/conditional ones in `style`.
- **Keep:** `.page` wrapper.
- **Migrate:** the ~19 static inline styles → Tailwind token utilities; `.muted`→`text-sm leading-6 text-muted-foreground` (margins per context), `.error`→`Alert`, `.card`→`Card` primitive (or specific primitive below), `<table className="table">`→`Table` primitive.
- **Adopt primitives:** `Grid` (the `repeat(auto-fit,minmax(180px,1fr))` stat grid ~177); `StatCard` (the `GrowthStat` tiles); `SectionHeader` (the currency-card headers with h2 + space-between ~139); `Alert` (the `.error` ~205 AND the hand-built insight alert box ~153-161 → `<Alert variant="info"|"warning">`); `EmptyState` (the empty `.muted` state ~215-223); `Table` (the monthly table).

---

### Task 1: Characterization test (safety net)

No test exists. Lock behavior first.

**Files:** Create `frontend/src/pages/LifestyleInflationPage.test.tsx`

- [ ] **Step 1: Write the test**

The page fetches `/api/reports/lifestyle-inflation` via `getJson` inside a `load()` callback (read the file for the response type + exact shape). Mirror the merged `SavingsRatePage.test.tsx` harness (it's the sibling page — same structure): `vi.mock('../lib/api')` returning a fixed lifestyle-inflation response (one currency with growth stats + a couple monthly rows), `import React`, `<ToastProvider>`, `<MemoryRouter>` only if a router hook errors. Read the response type to shape the mock.
Assert stable, migration-surviving behavior (roles/text only): the h1 heading (read the exact title), a growth-stat label or currency value that renders with data, and a monthly-table column header. ~3-4 assertions.

- [ ] **Step 2: Run green against the UNMODIFIED page**

Run: `yarn workspace frontend run test LifestyleInflationPage` → PASS. Fix the mock to match reality if needed — the page is source of truth.

- [ ] **Step 3: Commit**
```bash
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH git commit -am "test(lifestyle-inflation): characterization test before UI sweep"
```

---

### Task 2: Full de-drift + primitive adoption

Several focused commits, each keeping the Task 1 test green (`yarn workspace frontend run test LifestyleInflationPage` after EACH).

**Files:** Modify `frontend/src/pages/LifestyleInflationPage.tsx`

- [ ] **Step 1: Static inline styles → Tailwind utilities** (commit `refactor(lifestyle-inflation): static inline styles -> token utilities`)

Convert the ~19 static inline styles (grep `style={{`). Mapping examples:
- filter bar `{display:'flex',gap:12,alignItems:'flex-end',flexWrap:'wrap'}` → `flex flex-wrap items-end gap-3`; label wrappers `{display:'flex',flexDirection:'column',gap:4}` → `flex flex-col gap-1`.
- currency header `{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:8}` → `flex justify-between items-center mb-2` (or SectionHeader in Step 3).
- margins `{margin:0}`→`m-0`; `{margin:'0 0 6px'}`→`m-0 mb-1.5`; `{marginTop:12}`→`mt-3`; `{margin:'4px 0 0',fontSize:'1.25rem',fontWeight:600}`→`m-0 mt-1 text-xl font-semibold`.
- list `{margin:0,padding:0,listStyle:'none'}` → `m-0 p-0 list-none`.
- table `{minWidth:360}`→`min-w-[360px]`; wrapper `{marginTop:12,overflowX:'auto'}`→`mt-3 overflow-x-auto`; th/td `{textAlign:'right'|'left'}`→`text-right`/`text-left`.
- For the conditional-color cells: move any static `textAlign` to className, keep ONLY the computed/conditional `color` in `style`.

- [ ] **Step 2: Generic classes → primitives/tokens** (commit `refactor(lifestyle-inflation): generic classes use Alert/Card/Table + tokens`)

- `.muted` (×7) → `text-sm leading-6 text-muted-foreground` (+ migrated margin per context). Grep App.css to confirm the rule.
- `.error` (~205) → `<Alert variant="error" className="mb-4">{…}</Alert>` (import `Alert`).
- `.card` containers (×5) → `<Card>` primitive (preserve margins via className); where a `.card` is really the filter section or a stat container, prefer the specific primitive in Step 3. NOTE: if a `.card` section carries an `aria-label` (role=region landmark), keep it `<section aria-label>` with Card's class string inlined rather than `<Card>` (Card renders a div — see the SavingsRatePage sweep precedent).
- `<table className="table">` → `<Table>` primitive; keep `min-w-[360px]`.

- [ ] **Step 3: Adopt Grid + StatCard + SectionHeader + Alert(insight) + EmptyState** (commit `refactor(lifestyle-inflation): adopt Grid/StatCard/SectionHeader/Alert/EmptyState primitives`)

- stat grid (`repeat(auto-fit,minmax(180px,1fr))` ~177) → `<Grid minItemWidth={180} gap="md">`.
- `GrowthStat` tiles → `<StatCard label value … />` (deliberate standardization — note it). Preserve the computed delta color: if StatCard can't express it, keep the value's conditional color via a wrapping element or StatCard's `delta`/`metricKind` props if they fit; otherwise leave that one tile's color inline and note it.
- currency-card headers (h2 + space-between + OutpacingBadge) → `<SectionHeader title={currency} actions={<OutpacingBadge…/>} />`.
- the hand-built insight alert box (~153-161, bordered flex with icon + text) → `<Alert variant="info"` (or "warning" if it signals outpacing) `>…</Alert>` — choose the variant matching its current intent/color; preserve the icon + content.
- empty state (~215-223) → `<EmptyState title description? />`.

- [ ] **Step 4: Verify after each commit** — test green; `yarn workspace frontend run lint` clean.

---

### Task 3: DoD verification

**Files:** Modify `docs/ui-rules.md` only if a bespoke class needs logging.

- [ ] **Step 1: Verify** (from `frontend/src`):
```bash
grep -c "style={{" pages/LifestyleInflationPage.tsx      # expect only the genuinely-dynamic ones (~3-5: computed delta color, conditional negative color, conditional-render margins). Confirm each remaining is truly dynamic.
grep -oE 'className="(muted|error|row|card|statCard|tableWrap|table|emptyState|formGrid)"' pages/LifestyleInflationPage.tsx | wc -l   # expect 0
```
`.page` may remain. Any bespoke class the rules don't cover → log in `docs/ui-rules.md` "Rule gaps found during sweep".

- [ ] **Step 2: Full gates** — `yarn workspace frontend run lint` clean; `yarn workspace frontend run test LifestyleInflationPage` green; broad `yarn workspace frontend run test --run` green. Commit only if a doc edit was made (otherwise Task 2 commits stand).

---

## Self-Review
- **Coverage:** char test (T1); ~19 static inline → utilities + generic classes → primitives/tokens + Grid/StatCard/SectionHeader/Alert/EmptyState adoption (T2); DoD verify (T3). The ~7 dynamic styles kept (only truly computed/conditional ones). ✓
- **Look vs standardize:** de-drift look-preserving; StatCard/SectionHeader/Alert adoption deliberate standardizations — noted. ✓
- **Precedent reuse:** mirrors the merged SavingsRatePage sweep (same page family) — same primitives, same landmark caveat for aria-labelled `.card` sections. ✓
- **Risk:** medium — the GrowthStat computed delta color must be preserved through the StatCard adoption (flag DONE_WITH_CONCERNS if StatCard can't carry it cleanly); char test guards behavior.
