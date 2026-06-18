# ExplainMonthPage Sweep Plan

> REQUIRED SUB-SKILL: superpowers:subagent-driven-development. `cashflow-ui-sweep` Mode-A (page sweep).

**Goal:** Full de-drift of `frontend/src/pages/ExplainMonthPage.tsx` (426 lines; 19 inline styles ALL static, ~16 generic-class uses) + adopt DS primitives. Guarded by a new characterization test. No dynamic styles to keep.

## Global Constraints
- Worktree `/Users/connoradams/Developer/cashflow/.claude/worktrees/sweep-explain-month` (node_modules symlinked). Commit with `PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH git commit …` (or `--file` if `-m` blocked). Sole author, no Co-Authored-By. Token-only color; grep App.css for real rule bodies.

## Scope
- 19 static inline styles → Tailwind token utilities (flex/grid/gap/margin/min-width/text-align). The two custom grids: MoM stat grid `repeat(auto-fit,minmax(220px,1fr))` → `Grid minItemWidth={220}`; the finding-item row `grid-template-columns:1fr auto` → `grid-cols-[1fr_auto]`; the definition-list `auto 1fr` → `grid-cols-[auto_1fr]` (keep as arbitrary classes — bespoke fixed grids, fine).
- `.card` (×6) → `<Card>`; `.muted` (×10) → `text-sm leading-6 text-muted-foreground` (margin per context); `.error` → `<Alert variant="error">`; keep `.page`, `.input` (native input class — leave or note).
- Adopt: MoM stat tiles (the `border rounded p-3` boxes with dl, ~305-358) → `<StatCard>` in a `<Grid minItemWidth={220}>`; the stat-card header (`flex justify-between` ~312) → `<SectionHeader>` if it has title+actions, else token utilities; error/loading/empty → `Alert`/`EmptyState`.

## Task 1 — Characterization test
Create `frontend/src/pages/ExplainMonthPage.test.tsx`. Mock `../lib/api` getJson for `/api/reports/explain-month` (read the `ExplainMonthResponse` type; return a month summary with a couple findings + MoM stats). Mirror SavingsRatePage.test.tsx (vi.mock, React import, ToastProvider; no router hooks so likely no MemoryRouter needed — add if it throws). Assert roles/text only: h1 title, a finding/section heading, a MoM stat label. Must pass UNMODIFIED. Commit `test(explain-month): characterization test before UI sweep`.

## Task 2 — De-drift + adopt (3 commits, test green after each)
1. Static inline → token utilities (the 19) — commit `refactor(explain-month): static inline styles -> token utilities`.
2. `.card`→Card, `.muted`→tokens, `.error`→Alert — commit `refactor(explain-month): generic classes use Card/Alert + tokens`.
3. MoM stat grid → `Grid`+`StatCard`, header → `SectionHeader` — commit `refactor(explain-month): adopt Grid/StatCard/SectionHeader`.
Preserve all data/handlers (buildTransactionsHref links, filters). Grep App.css for real rules.

## Task 3 — DoD
From `frontend/src`: `grep -c "style={{" pages/ExplainMonthPage.tsx` → 0 (all drift); `grep -oE 'className="(muted|error|card|statCard|tableWrap|table|emptyState|formGrid)"' pages/ExplainMonthPage.tsx | wc -l` → 0. `.page`/`.input` may remain. lint + full suite green.

## Self-Review
All 19 inline drift → tokens; generic classes → primitives; Grid/StatCard/SectionHeader adopted; char test guards. Low risk (no dynamic styles, no coupling). The 3 bespoke grids (`1fr auto`, `auto 1fr`, the MoM auto-fit→Grid) handled explicitly.
