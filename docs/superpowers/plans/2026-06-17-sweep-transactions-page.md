# TransactionsPage Partial De-Drift Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]` checkboxes.

**Goal:** Remove the **generic-utility drift** from `frontend/src/pages/TransactionsPage.tsx` (2,658 lines) — migrate the legacy utility classes the design-system rules cover, and LEAVE the page's legitimate bespoke component CSS (logged as a component-extraction follow-up). This is a PARTIAL sweep with a relaxed DoD: **no generic-utility drift**, NOT zero raw classes.

**Why partial:** TransactionsPage's 42 raw classes are mostly legitimate bespoke component styles (sticky action column, AI result panels, filter pills, amount cells, cloud pickers) with no token/primitive equivalent. Forcing them to zero would mean inventing primitives or bloating JSX — a separate, larger project. This pass removes only the true drift.

**Tech Stack:** React 19, Tailwind v4 token utilities, vitest. Worked reference: the merged AccountsPage + ReportsPage sweeps; `docs/ui-rules.md`.

## Global Constraints
- Run from repo root: `/Users/connoradams/Developer/cashflow/.claude/worktrees/sweep-transactions-page`.
- Commit husky workaround, exact prefix: `PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH git commit -m "…"` (if `-m` blocked, `git commit --file=<tmpfile>`). Sole author — NEVER add Co-Authored-By.
- Color = tokens only: no hex; map each migrated class to its ACTUAL App.css rule body (grep App.css — do NOT trust quoted bodies).
- Every task ends green on the EXISTING `frontend/src/pages/TransactionsPage.test.tsx` (363 lines — the safety net) + `yarn workspace frontend run lint`.
- Behavior/look preserving. The settlement/reimbursable dialogs and aria wiring must be untouched unless explicitly listed.

## MIGRATE (the drift — these have rules/token equivalents)
- `.muted` (×28) → `text-sm leading-6 text-muted-foreground`, with `mb-0` where an inline `marginBottom:0`/`mb-0` override existed, else `mb-4`. (Grep App.css `.muted` to confirm: `mb-4 text-sm leading-6` + `color: var(--muted-foreground)`.)
- `.error` (×2, block-level page/upload errors at ~1240, ~1421) → `<Alert variant="error" className="mb-4">…</Alert>` (import `Alert` from `@/components/ui/alert`). Confirm neither is an aria-wired form-field error before converting; if one is field-level, only swap `.error`→`text-danger` keeping its element/id.
- `.row` (×3, App.css `mb-3 flex flex-wrap items-center gap-3`) → `mb-3 flex flex-wrap items-center gap-3` (drop the class; merge any compound like `transactionsActionRow`/`transactionsPager` per below).
- Trivial spacing-only aliases → inline the single utility, drop the class:
  - `transactionsToolbar` (mb-4) — see Card note below.
  - `transactionsHelperCopy` (mb-0 mt-2) → `mb-0 mt-2`
  - `transactionsActionRow` (mt-3) → fold into the `.row` swap as `mt-3`
  - `transactionsPager` (mb-0 mt-4 justify-center) → fold into the `.row` swap as `mb-0 mt-4 justify-center`
  - `aiVisibilityMore` (text-xs, used with `.muted`) → `text-xs` (the `.muted` part handled above)
  - `transactionsTableCard` (mb-0) → fold into the Card note below.
- The `card …` raw wrappers that are SIMPLE filter/table cards → the `Card` primitive (it provides the `.card` surface):
  - `<section className="card transactionsToolbar">` (~1117) → `<Card className="mb-4">`
  - `<section className="card transactionsTableCard">` (~1751) → `<Card className="mb-0">`
  - Import `Card` from `@/components/ui/card`. Keep all children unchanged.
- Simple grids (rules-covered) → arbitrary token classes:
  - `transactionsStats` (App.css `mb-4 grid gap-3` + `repeat(auto-fit,minmax(160px,1fr))`) → `mb-4 grid gap-3 grid-cols-[repeat(auto-fit,minmax(160px,1fr))]`
  - `formGrid` + `transactionsFilterGrid` (App.css `mb-3 grid gap-3` + `repeat(auto-fit,minmax(150px,1fr))`) → `mb-3 grid gap-3 grid-cols-[repeat(auto-fit,minmax(150px,1fr))]`

## LEAVE (bespoke component CSS — do NOT touch; log as follow-up in Task 4)
`aiVisibilityPanel`/`aiVisibilityHeader`/`aiVisibilityList`/`aiVisibilityItem`/`aiVisibilityItemHeader` (AI result cards — own color-mix borders), `card bulkBar transactionsBulkCard` + `transactionsBulkHeader` (bulk bar layout), all `txn*` cell classes (`txnMerchantCell`, `txnAmountCell`, `txnAmount--expense/--credit`, `txnSplitCell`, `txnStatusCell`, `txnBadge*`, `txnActionGroup`, `txnAiInsight`, `txnReceipt*`, `txnResetButton`/`txnSaveButton`, `txnCategoryCell`, `txnPercentInput`, `txnSplitPercents`, `txnCounterparty`), `transactionsFilterPill*`, `quickFilters`/`quickFilterButton`, `transactionsPanelBadge`, `transactionsPanelHeader`, `transactionsToolbarMeta`, `transactionsCheckTile`, `transactionsCategory*`/`transactionsBulkCategory*` cloud pickers, `transactionsActionsCol` (sticky right column), `transactionsTableWrap`/`tableWrap`+`table`/`transactionsTable` (sticky+max-height scroll — leave for a dedicated table pass), `narrowCol`, `transactionsLabelFilter`, `transactionsFilterPills`, `uploadMsg`, `checkRow`, `transactionsCategoryField`.
> Rationale: these encode bespoke layout/sticky/color the rules don't cover. Migrating them = inventing primitives = out of scope for a de-drift pass.

---

### Task 1: Verify the safety net

**Files:** none (read-only check).

- [ ] **Step 1: Confirm the existing test passes on the base**

Run: `yarn workspace frontend run test TransactionsPage`
Expected: all existing tests pass (363-line suite). This is the green gate for Tasks 2-3. If it fails on the untouched base, STOP and report — do not migrate against a red base.

---

### Task 2: Migrate `.muted` ×28 → token utilities

The bulk mechanical win, lowest risk.

**Files:** Modify `frontend/src/pages/TransactionsPage.tsx`

- [ ] **Step 1: Replace every `.muted`**

Grep `frontend/src/App.css` for `.muted` to confirm the rule (`mb-4 text-sm leading-6` + `color: var(--muted-foreground)`). Replace each `className="muted …"` / `className="… muted …"` occurrence (28 of them, incl. compounds like `muted aiVisibilityMore`, `muted transactionsHelperCopy`) so the `muted` token resolves to `text-sm leading-6 text-muted-foreground`, preserving the margin that actually applied (inline `mb-0`/`marginBottom:0` override → `mb-0`; otherwise `mb-4`). For compounds, keep the OTHER class only if it is in the LEAVE list; if the other class is a MIGRATE spacing alias (`aiVisibilityMore`→`text-xs`, `transactionsHelperCopy`→`mb-0 mt-2`, `transactionsActionRow`→`mt-3`), inline that too.
> If a `muted` sits on an inline `<span>` where margin never applied, just `text-sm leading-6 text-muted-foreground` (or `text-xs …` where an inline fontSize said so).

- [ ] **Step 2: Verify + commit**

Run `yarn workspace frontend run test TransactionsPage` (green). Confirm `grep -c 'className="muted\|"muted ' frontend/src/pages/TransactionsPage.tsx` trends toward 0 (any remaining `muted` only inside a LEAVE-list compound is acceptable — note it). Then:
```bash
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH git commit -am "refactor(transactions): .muted -> token utilities"
```

---

### Task 3: Errors, rows, simple cards + grids, spacing aliases

**Files:** Modify `frontend/src/pages/TransactionsPage.tsx`

- [ ] **Step 1: `.error` → Alert**

The two block-level errors (~1240, ~1421) → `<Alert variant="error" className="mb-4">{…}</Alert>` (import `Alert`). Verify neither is wired to an input via `aria-describedby`; if one is, only swap `.error`→`text-danger` and keep its element + id.
Commit: `refactor(transactions): block errors use Alert`

- [ ] **Step 2: Simple cards → Card primitive; `.row` + spacing aliases → utilities; simple grids → arbitrary classes**

Apply the MIGRATE list:
- `<section className="card transactionsToolbar">` → `<Card className="mb-4">`; `<section className="card transactionsTableCard">` → `<Card className="mb-0">` (import `Card`).
- `.row` (×3) → `mb-3 flex flex-wrap items-center gap-3`, folding `transactionsActionRow`→add `mt-3`, `transactionsPager`→`mb-0 mt-4 justify-center flex flex-wrap items-center gap-3`.
- `transactionsHelperCopy` → `mb-0 mt-2`.
- `transactionsStats` → `mb-4 grid gap-3 grid-cols-[repeat(auto-fit,minmax(160px,1fr))]`.
- `formGrid transactionsFilterGrid` → `mb-3 grid gap-3 grid-cols-[repeat(auto-fit,minmax(150px,1fr))]`.
Leave everything in the LEAVE list untouched.
Commit: `refactor(transactions): simple cards/grids/rows use primitives + token utilities`

- [ ] **Step 3: Verify** — `yarn workspace frontend run test TransactionsPage` green after each commit.

---

### Task 4: Relaxed-DoD verification + log the follow-up

**Files:** Modify `docs/ui-rules.md`

- [ ] **Step 1: Verify the drift is gone**

From `frontend/src`:
```bash
grep -c "style={{" pages/TransactionsPage.tsx                     # should drop to 3 (the 3 static layout styles are LEAVE: display:none, two width:64) — confirm no NEW ones
grep -oE 'className="(muted|error|row|card|transactionsToolbar|transactionsTableCard|transactionsHelperCopy|transactionsActionRow|transactionsPager|transactionsStats|formGrid)"' pages/TransactionsPage.tsx | wc -l   # MIGRATE-list classes: expect 0
```
The MIGRATE-list classes should be 0. Bespoke LEAVE-list classes remaining is expected and correct.

- [ ] **Step 2: Log the component-extraction follow-up**

Append to `docs/ui-rules.md` a section:
```markdown
## TransactionsPage — bespoke classes deferred to component extraction (2026-06-17)
TransactionsPage was partially de-drifted (generic utilities migrated). The following bespoke component classes remain by design — they encode sticky columns, AI result panels, filter pills, amount cells, and cloud-picker layouts with no current primitive. A future component-extraction project should turn these into primitives: aiVisibility* (AI result card), bulkBar/transactionsBulkCard (bulk action bar), txn* cell classes (ledger row cells), transactionsFilterPill*, quickFilter*, transactionsActionsCol (sticky right column), transactionsTableWrap/transactionsTable (sticky + max-height scroll), transactionsCategory*/Bulk* cloud pickers, transactionsPanelBadge, transactionsCheckTile.
```

- [ ] **Step 3: Full gates + commit**

`yarn workspace frontend run lint` clean; `yarn workspace frontend run test TransactionsPage` green. Then:
```bash
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH git commit -am "docs(ui): log TransactionsPage bespoke classes for component-extraction follow-up"
```

---

## Self-Review
- **Coverage:** drift = `.muted`×28 (T2), `.error`/`.row`/simple cards+grids+spacing aliases (T3); bespoke explicitly LEFT + logged (T4). Relaxed DoD (no generic-utility drift) stated up front. ✓
- **Risk:** low — `.muted` is mechanical; the bespoke/risky classes (sticky cols, AI panels, cloud pickers, dialogs) are explicitly untouched. The existing 363-line test is the safety net.
- **No placeholders:** every migrate target has its source rule + replacement; the LEAVE list is explicit so there's no per-class guessing.
