# SavingsRatePage Sweep Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]` checkboxes.

**Goal:** Full UI sweep of `frontend/src/pages/SavingsRatePage.tsx` (451 lines; top drift-ranked page: 36 inline styles, generic legacy classes). De-drift to token utilities AND adopt the design-system primitives (Grid, StatCard, SectionHeader, Alert, EmptyState) — guarded by a new characterization test. The ONE dynamic inline style (conditional savings-rate color) stays inline.

**Architecture:** Pure frontend. Swap static inline styles + generic App.css classes for primitives + Tailwind token utilities. This sweep both removes drift and spreads the newly-extracted primitives (the currency-summary `Stat` tiles + their grid become a `Grid` of `StatCard`s — the blessed stat-grid pattern).

**Tech Stack:** React 19, Tailwind v4, vitest. Worked references (merged): AccountsPage/ReportsPage sweeps; the Grid/SectionHeader primitives; `docs/ui-rules.md`.

## Global Constraints
- Run from repo root: `/Users/connoradams/Developer/cashflow/.claude/worktrees/sweep-savings-rate` (node_modules symlinked — `yarn workspace frontend run test` works).
- Commit husky workaround, exact prefix: `PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH git commit -m "…"` (if `-m` blocked, `git commit --file=<tmpfile>`). Sole author — NEVER add Co-Authored-By.
- Color = tokens only: no hex; map each dropped class to its ACTUAL App.css rule (grep — don't trust quotes); no `var(--)` in inline styles EXCEPT the one dynamic conditional color.
- Look-preserving for de-drift; the primitive adoptions (StatCard, SectionHeader) are deliberate standardizations toward the DS look — note them, don't hide them.
- Every task ends green on the characterization test (Task 1) + `yarn workspace frontend run lint`.

## Scope
- **Keep inline (DYNAMIC):** the savings-rate cell color (~line 334-342): `style={{ textAlign:'right', color: m.savingsRatePct==null ? 'var(--muted-foreground)' : m.savingsRatePct<0 ? 'var(--danger)' : undefined }}`. Keep the conditional color inline; the `textAlign:'right'` part → `className="text-right"` (move the static part out, keep only the dynamic color in `style`).
- **Keep:** `.page` wrapper (rules bless it).
- **Migrate everything else:** the other ~30 static inline styles → Tailwind token utilities; `.muted`→`text-sm leading-6 text-muted-foreground` (margins per context), `.error`→`Alert`, `.card`→`Card` primitive, `.table`→`Table` primitive.
- **Adopt primitives:** `Grid` (the `repeat(auto-fit,minmax(150px,1fr))` wrapper ~234), `StatCard` (the `Stat` sub-component tiles ~270-295), `SectionHeader` (the card headers with h2 + `justifyContent:space-between` ~222-227, and the formula explainer/table headings where they fit), `EmptyState` (the empty `.muted` state ~144).

---

### Task 1: Characterization test (safety net)

SavingsRatePage has no test. Lock behavior before the sweep.

**Files:** Create `frontend/src/pages/SavingsRatePage.test.tsx`

- [ ] **Step 1: Write the test**

The page fetches via the `useReportData` hook (`/api/reports/savings-rate`). Mirror an existing page test for the harness (`vi.mock`, `<ToastProvider>`, `import React`, `<MemoryRouter>` if a router hook errors). Mock the data layer at its source — inspect the page's imports: it uses `useReportData` from a hook module and `ReportFilterBar`. Mock whichever is cleanest (`vi.mock` the `useReportData` hook module to return a fixed `{ data, loading:false, err:null, availableCurrencies:['CAD'], windowLabel:'…', reload: vi.fn() }` with one currency summary + a couple monthly rows; or mock `../lib/api` getJson if the hook calls it directly). Read the `SavingsRateResponse` type to shape the mock.
Assert stable, migration-surviving behavior (roles/text only, never classNames):
```tsx
// header
expect(await screen.findByRole('heading', { name: /savings rate/i, level: 1 })).toBeInTheDocument()
// a currency summary value or a stat label that always renders with data
// a monthly table column header (e.g. "Income" or "Savings rate")
```
Pick exact strings by reading the page. ~3-4 assertions.

- [ ] **Step 2: Run it green against the UNMODIFIED page**

Run: `yarn workspace frontend run test SavingsRatePage` → PASS (characterizes current behavior). Fix the mock to match reality if it fails — the page is source of truth.

- [ ] **Step 3: Commit**
```bash
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH git commit -am "test(savings-rate): characterization test before UI sweep"
```

---

### Task 2: Full de-drift + primitive adoption

Bundle the migration as several focused commits, each keeping the Task 1 test green. Run `yarn workspace frontend run test SavingsRatePage` after EACH commit.

**Files:** Modify `frontend/src/pages/SavingsRatePage.tsx`

- [ ] **Step 1: Static inline styles → Tailwind utilities**

Convert the ~30 static inline `style={{}}` to token utilities (grep `style={{` to find them). Mapping examples (apply to all analogous):
- flex rows `{display:'flex',gap:16,flexWrap:'wrap',marginTop:12}` → `className="flex flex-wrap gap-4 mt-3"`; `{display:'flex',gap:6,alignItems:'center'}` → `flex items-center gap-1.5`.
- margin overrides `{margin:'8px 0 0'}` → `mt-2`; `{margin:'0 0 8px'}` → `mb-2`; `{margin:0}` → `m-0`; `{margin:'4px 0 0'}` → `mt-1`.
- typography `{fontSize:'1rem'}` → `text-base`; `{fontSize:'1.25rem',fontWeight:600}` → `text-xl font-semibold`.
- list `{margin:0,paddingLeft:18}` → `m-0 pl-4`.
- table `{minWidth:520}` → `min-w-[520px]`; wrapper `{marginTop:12,overflowX:'auto'}` → `mt-3 overflow-x-auto`.
- the 12 `{textAlign:'right'}` th/td → `className="text-right"`; drop the redundant `{textAlign:'left'}` (default).
- The DYNAMIC savings-rate cell: keep `style={{ color: <conditional> }}` ONLY (move `textAlign:'right'` to `className="text-right"`).
Commit: `refactor(savings-rate): static inline styles -> token utilities`

- [ ] **Step 2: Generic classes → primitives/tokens**

- `.muted` (×4) → `text-sm leading-6 text-muted-foreground` (+ the migrated margin from Step 1 where they co-occur).
- `.error` (~133) → `<Alert variant="error" className="mb-4">{…}</Alert>` (import `Alert`). If it's a field-level error wired to an input, keep as `text-danger` span instead.
- `.card` containers (×5) → `<Card>` primitive (import `Card`), preserving any margin via className. Where a `.card` is really a stat tile or filter wrapper, prefer the specific primitive below.
- `<table className="table">` → `<Table>` primitive (import from `@/components/ui/table`); drop the `.table` class; keep the `min-w-[520px]` on the Table if needed for scroll.
Commit: `refactor(savings-rate): generic classes use Alert/Card/Table + tokens`

- [ ] **Step 3: Adopt Grid + StatCard + SectionHeader + EmptyState**

- The currency-summary grid (`<div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(150px,1fr))',gap:12}}>` ~234) → `<Grid minItemWidth={150} gap="md">` (import `Grid` from `@/components/ui/grid`).
- The `Stat` sub-component tiles (~270-295, a `<div border rounded p-3>` with label + value) → `<StatCard label={…} value={…} />` (import `StatCard`). This standardizes the tiles to the DS stat-card look (a deliberate visual change toward consistency — note it). If `Stat` is a local component, either rewrite its body to return `<StatCard>` or replace its call sites.
- Card headers (the `<div style={{display:'flex',justifyContent:'space-between',alignItems:'center'}}><h2>…</h2>…</div>` ~222-227, and the explainer/table section headings ~179/307) → `<SectionHeader title={…} description?={…} actions?={…} />` (import `SectionHeader`) where the shape fits (title + optional right-side). For a bare `<h3>` heading with no description/actions, a token-utility heading is fine — don't force SectionHeader where there's only a title.
- The empty state (~144, `<p className="muted">` shown when no data) → `<EmptyState title={…} description?={…} />` (import from `@/components/ui/empty-state`).
Commit: `refactor(savings-rate): adopt Grid/StatCard/SectionHeader/EmptyState primitives`

- [ ] **Step 4: Verify after each commit** — `yarn workspace frontend run test SavingsRatePage` green; `yarn workspace frontend run lint` clean.

---

### Task 3: DoD verification + log

**Files:** Modify `docs/ui-rules.md` (only if a bespoke class remains to log)

- [ ] **Step 1: Verify the sweep**

From `frontend/src`:
```bash
grep -c "style={{" pages/SavingsRatePage.tsx     # expect 1 (the dynamic savings-rate color)
grep -oE 'className="(muted|error|row|card|statCard|tableWrap|table|emptyState|formGrid)"' pages/SavingsRatePage.tsx | wc -l   # expect 0
```
Confirm the single remaining inline style is the dynamic conditional color. Any bespoke `savingsRate*` class the rules don't cover → log in `docs/ui-rules.md` "Rule gaps found during sweep" rather than leaving silently. `.page` may remain (blessed).

- [ ] **Step 2: Full gates + commit (only if Step 1 needed a doc edit; otherwise the Task 2 commits stand)**

`yarn workspace frontend run lint` clean; `yarn workspace frontend run test SavingsRatePage` green; a broad `yarn workspace frontend run test --run` green. If a doc edit was made:
```bash
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH git commit -am "docs(ui): log SavingsRatePage sweep rule-gaps"
```

---

## Self-Review
- **Coverage:** char test (T1); 30 static inline styles → utilities + generic classes → primitives/tokens + Grid/StatCard/SectionHeader/EmptyState adoption (T2); DoD verify (T3). The 1 dynamic color kept inline. ✓
- **Look vs standardize:** de-drift is look-preserving; StatCard/SectionHeader adoption is deliberate standardization toward the DS — noted in the relevant commits/report. ✓
- **Risk:** medium — StatCard adoption changes the stat-tile look (fuller card vs the light bordered tile); the characterization test guards behavior, and the change is the intended DS standardization. If StatCard's look is too heavy for these dense tiles, the implementer should report it as DONE_WITH_CONCERNS rather than forcing it.
