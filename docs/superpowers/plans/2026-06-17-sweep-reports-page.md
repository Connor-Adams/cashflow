# ReportsPage Sweep Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]` checkboxes.

**Goal:** Migrate `frontend/src/pages/ReportsPage.tsx` (worst UI-debt page: 1,087 lines, 33 raw App.css classes, 8 inline styles) to `docs/ui-rules.md` + the hardened `ui/` primitives — look-preserving, behavior-preserving — guarded by a new characterization test.

**Architecture:** Pure frontend. Swap raw App.css classes + inline styles for primitives (`StatCard`, `Alert`, `EmptyTableRow`, `Table*`) and Tailwind token utilities. The AccountsPage migration (on main) is the worked example; `docs/ui-rules.md` is the standard.

**Tech Stack:** React 19, Tailwind v4 token utilities, vitest. Worked reference: `git show` the AccountsPage migration commits, or read `frontend/src/pages/AccountsPage.tsx`.

## Global Constraints
- Run from repo root: `/Users/connoradams/Developer/cashflow/.claude/worktrees/sweep-reports-page`.
- Commit husky workaround, exact prefix: `PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH git commit -m "…"` (if `-m` blocked, `git commit --file=<tmpfile>`). Sole author — NEVER add Co-Authored-By.
- Color = tokens only: no hex; no raw App.css utility classes the rules cover; no `var(--)` in `style={{}}` (a Tailwind arbitrary-value class like `text-[var(--token)]` is acceptable, an inline style is not).
- Look-preserving: map each dropped class to its ACTUAL App.css rule body (grep App.css — do NOT trust quoted bodies; a prior task found the brief misquoted a rule). The ONLY allowed visual change is incidental polish explicitly noted.
- Every task ends green on the characterization test (Task 1) + `yarn workspace frontend run lint`.
- Reference: `docs/ui-rules.md`, `docs/superpowers/specs/2026-06-17-ui-primitive-audit.md`.

## Known landmines (handle, don't bulldoze)
1. **Sticky table headers**: App.css coordinates `.tableWrap { overflow: visible }` under `[data-slot="collapsible-card"]` so `position: sticky` headers work. The `Table` primitive self-wraps in `overflow-x-auto`, which can CLIP sticky headers. Task 4 verifies this by running the app before committing the table swap.
2. **Dynamic colors**: lines ~643/683 set `style={{ color: partnerOwesMe ? 'var(--accent-green)' : 'var(--danger)' }}`. Replace with a conditional token className, not an inline var.
3. **Settlement dialog validation**: form errors are aria-wired (`aria-describedby` → error spans, lines ~1008-1077). Preserve the id/aria linkage when swapping `.error` spans.

---

### Task 1: Characterization test (safety net)

ReportsPage has no dedicated test. Lock behavior first.

**Files:**
- Create: `frontend/src/pages/ReportsPage.test.tsx`

**Interfaces:**
- Consumes (mock these): `getJson` for `/api/summary/partner`, `/api/summary/business`, `/api/summary/dashboard`, `/api/contacts`, `/api/settlements`; plus `postJson`, `deleteReq`.
- Produces: the green gate for Tasks 2-5.

- [ ] **Step 1: Write the test**

Mirror `frontend/src/pages/AccountsPage.test.tsx` (on main) for the harness: `vi.mock('../lib/api', …)`, `import React from 'react'`, wrap in `<ToastProvider>`; ReportsPage also uses routing (hash-anchor scroll + FilterBar) — if a render throws for Router context, wrap in `<MemoryRouter>`. The api mock's `getJson` must branch on the URL and return a sane shape per endpoint (read ReportsPage's response types at the top of the file — `PartnerRow`, `BusRow`, `DashboardSummarySubset`, `Contact[]`, `PartnerSettlementsResponse`). Assert stable behavior that survives a CSS migration:
```tsx
// after mounting with one partner row + one settlement:
expect(await screen.findByRole('heading', { name: /reports/i, level: 1 })).toBeInTheDocument()
// a stat label that the page always renders (pick a real one from lines ~553-576, e.g. the first statLabel text)
// a settlement table cell or the "record settlement" button
expect(await screen.findByRole('button', { name: /settlement/i })).toBeInTheDocument()
```
Pick the exact assertion strings by reading the rendered text in ReportsPage.tsx. Assert on roles/text, never on classNames.

- [ ] **Step 2: Run it against the UNMODIFIED page**

Run: `yarn workspace frontend run test ReportsPage`
Expected: PASS (characterizes current behavior). If it fails, fix the test/mock to match reality — the page is the source of truth.

- [ ] **Step 3: Commit**

```bash
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH git commit -am "test(reports): characterization test before UI migration"
```

---

### Task 2: Stat cards + grids + muted/inline-text (bulk mechanical)

The look-preserving, low-risk swaps. Several commits, all gated by Task 1's test.

**Files:**
- Modify: `frontend/src/pages/ReportsPage.tsx`

- [ ] **Step 1: Stat cards → StatCard primitive**

Lines ~551-583: a `.reportsStats` grid of four `<article className="card statCard">` blocks (each with `.statLabel`/`.statValue`/`.statHint`). Replace with the blessed stat-grid (see AccountsPage / `docs/ui-rules.md`):
```tsx
<div className="mb-4 grid gap-3 grid-cols-[repeat(auto-fit,minmax(180px,1fr))]">
  <StatCard label={/* verbatim label 1 */} value={/* verbatim value 1 */} hint={/* verbatim hint 1 */} />
  … (4 total)
</div>
```
Import `StatCard` from `@/components/ui/stat-card`. Copy each label/value/hint expression verbatim from the old blocks. Drop `.reportsStats`/`.card`/`.statCard`/`.statLabel`/`.statValue`/`.statHint`.
Commit: `refactor(reports): stat grid uses StatCard primitive`

- [ ] **Step 2: Grids + inline layout styles → token utilities**

- `.reportsGrid` (App.css: `grid gap-4` + `grid-template-columns: repeat(auto-fit, minmax(min(100%,320px),1fr))`) → `className="grid gap-4 grid-cols-[repeat(auto-fit,minmax(min(100%,320px),1fr))]"`.
- `.formGrid` + its inline `style={{display:'grid',gap:'0.75rem'}}` (line ~943) → `className="mb-3 grid gap-3 grid-cols-[repeat(auto-fill,minmax(min(100%,180px),1fr))]"` (drop the inline style).
- `.partnerNetRollup` inline list style (line ~627: `listStyle:none;padding:0;margin:0 0 0.75rem 0;display:flex;flexDirection:column;gap:0.25rem`) → `className="list-none p-0 mb-3 flex flex-col gap-1"` (drop inline style).
- The small text inline styles (lines ~632/641/702 `fontSize` etc.) → `text-sm` / `text-xs` utilities.
- `.muted` (App.css `mb-4 text-sm leading-6` + muted color; many have inline `marginBottom:0` overrides) → `text-sm leading-6 text-muted-foreground` plus `mb-0` where the inline override existed, else `mb-4`.
Commit: `refactor(reports): grids and text use token utilities`

- [ ] **Step 3: Verify + (the commits above)**

After EACH commit run `yarn workspace frontend run test ReportsPage` (green) — do not batch.

---

### Task 3: Error banners + empty states → primitives

**Files:**
- Modify: `frontend/src/pages/ReportsPage.tsx`

- [ ] **Step 1: Error spans → Alert**

Lines ~548, ~788, ~1066: `<… className="error">{err}</…>` page/section-level errors → `<Alert variant="error" className="mb-4">{err}</Alert>` (import `Alert` from `@/components/ui/alert`). For the two FORM field errors (`.error text-xs`, lines ~1030/1052) inside the settlement dialog: these are inline field validation tied to `aria-describedby` — do NOT convert these to `Alert` (Alert is a block region). Instead keep them as `<span className="text-danger text-xs" id={…}>` preserving the existing `id`/`aria-describedby` wiring; only swap the `.error` class for `text-danger`.
Commit: `refactor(reports): page errors use Alert, form errors use text-danger token`

- [ ] **Step 2: Empty table rows → EmptyTableRow**

Lines ~666/763/804/1144: `<td className="emptyStateCell"><p className="emptyState">…</p></td>` patterns inside tables → `<EmptyTableRow colSpan={N} title={…} description={…} />` (import from `@/components/ui/empty-state`). Match each `colSpan` to that table's column count (count its `<TableHead>`s). Keep the existing empty-copy text.
Commit: `refactor(reports): empty states use EmptyTableRow primitive`

- [ ] **Step 3: Verify** — `yarn workspace frontend run test ReportsPage` green after each commit.

---

### Task 4: Tables (de-wrap) — WITH sticky-header verification

HIGH RISK. The `.tableWrap` div + `.table` class wrap the `Table` primitive; sticky headers depend on overflow coordination. Verify, don't assume.

**Files:**
- Modify: `frontend/src/pages/ReportsPage.tsx` (table wrappers at ~652, ~752, ~789, ~1131)

- [ ] **Step 1: Check whether these tables use sticky headers**

Grep App.css for `sticky` near `.tableWrap`/`collapsible-card` (the investigator cited ~lines 338-343). Read ReportsPage's `<TableHead>`/`thead` usage and the CollapsibleCard. Determine: do ReportsPage's tables actually render sticky headers? State the finding in your report.

- [ ] **Step 2: Migrate the wrappers**

Replace `<div className="tableWrap"><Table className="table">…</Table></div>` → `<Table>…</Table>` (the primitive self-wraps in an overflow container and sets `w-full text-sm`). Do this for all four.

- [ ] **Step 3: VERIFY in the running app (required before commit)**

Start the app and look at the Reports page tables — scroll a long table and confirm header behavior matches before/after (sticky stays sticky, or was never sticky). Use the project's run pattern (`yarn dev`, or the `run`/preview tooling) and a screenshot. If sticky headers BREAK from dropping `.tableWrap`:
- Do NOT ship the regression. Either keep a minimal wrapper that preserves the overflow coordination, or replicate the needed overflow utility on a wrapping div, whichever restores the original behavior. Document what you did and why in your report (this is a legitimate rule-gap: log it in `docs/ui-rules.md` under "Rule gaps found during sweep").

- [ ] **Step 4: Verify tests + commit**

`yarn workspace frontend run test ReportsPage` green. Then:
```bash
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH git commit -am "refactor(reports): tables use Table primitive (sticky-header behavior verified)"
```

---

### Task 5: Dynamic conditional colors → token classes

**Files:**
- Modify: `frontend/src/pages/ReportsPage.tsx` (lines ~643, ~683, and any other conditional `style={{ color: … }}`)

- [ ] **Step 1: Replace conditional inline colors with conditional token classNames**

Pattern: `style={{ color: partnerOwesMe ? 'var(--accent-green)' : 'var(--danger)', fontWeight: 600 }}`. Determine the available positive token utility (check the Tailwind `@theme` mapping in `index.css`/config: is there a `text-positive`? `text-[var(--accent-green)]`? — `--accent-green` and `--danger` both exist). Replace with:
```tsx
className={cn('font-semibold', positive ? '<positive-token-class>' : 'text-danger')}
```
using `cn` from `@/lib/utils`. Pick the positive class that resolves to the same green (`text-[var(--accent-green)]` is a safe arbitrary-value fallback if no named utility exists). Remove the inline `style` color. Keep any non-color inline style only if it has no utility equivalent (note it if so).

- [ ] **Step 2: Final DoD verification**

Run from `frontend/src`:
```bash
grep -c "style={{" pages/ReportsPage.tsx
grep -oE 'className="(reportsStats|card statCard|statCard|statLabel|statValue|statHint|reportsGrid|formGrid|tableWrap|table|error|emptyState|emptyStateCell|muted|partnerNetRollup)"' pages/ReportsPage.tsx | wc -l
```
Target: inline styles 0 (or only documented non-utility-expressible ones, logged); rules-covered classes 0. Any remaining App.css class the rules don't cover → log in `docs/ui-rules.md` "Rule gaps found during sweep".

- [ ] **Step 3: Full gates + commit**

`yarn workspace frontend run lint` clean; `yarn workspace frontend run test ReportsPage` green. Then:
```bash
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH git commit -am "refactor(reports): conditional colors use token classes; sweep complete"
```

---

## Self-Review
- **Coverage:** stat cards/grids/muted (T2); errors/empty states (T3); tables+sticky (T4); dynamic colors (T5); all under the T1 char test. The 33 classes + 8 inline styles map to T2-T5. ✓
- **Landmines:** sticky headers (T4 Step 3 verifies in-app), dynamic colors (T5), dialog aria (T3 Step 1 preserves id/aria). ✓
- **Look-preservation:** every swap maps to the real App.css rule (grep, don't trust quotes). Only the Button-hover-style incidental changes are disallowed here — this is a page, not a primitive. ✓
- **Risk:** T4 is the one that can regress; it has an explicit in-app visual gate before commit.
