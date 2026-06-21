# MoneyLeaksPage Sweep Plan

> REQUIRED SUB-SKILL: superpowers:subagent-driven-development. cashflow-ui-sweep Mode-A.

**Goal:** De-drift `frontend/src/pages/MoneyLeaksPage.tsx` (447 lines; 14 inline = 13 static + 1 dynamic tone color, generic `.card`/`.muted`/`.error`) + adopt DS primitives. Char-test guarded. Keep the 1 dynamic tone color.

## Constraints
Worktree `/Users/connoradams/Developer/cashflow/.claude/worktrees/sweep-money-leaks` (node_modules symlinked). Commit `PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH git commit …` (or `--file`). Sole author, no Co-Authored-By. Token-only; grep App.css for real rules.

## Scope
- 13 static inline → token utilities (flex/grid/gap/margin/padding/border-b/text-size). LeakTotals grid `repeat(auto-fit,minmax(180px,1fr))` → `Grid minItemWidth={180}`. Leak-item grid `auto 1fr auto` → `grid-cols-[auto_1fr_auto]` (bespoke fixed grid, keep as arbitrary class).
- KEEP dynamic: SummaryStat value `color: tone==='warn' ? 'var(--accent-warm)' : undefined` — either keep inline OR map to StatCard's `metricKind` if adopting StatCard (see below).
- `.card`(×5)→`<Card>`; `.muted`→`text-sm leading-6 text-muted-foreground` (size per context); `.error`→`<Alert variant="error">`. Keep `.page`.
- Adopt: LeakTotals stat grid → `<Grid minItemWidth={180}>`; SummaryStat tile (Card + label + value) → `<StatCard label value>` — if the warn tone maps cleanly to StatCard's `metricKind`/`delta` use it; else convert the tile to token utilities + keep the conditional color inline (note it). Empty `.muted`-in-card states → `<EmptyState>` where they're true empty states. CollapsibleCard usages stay (already a primitive).

## Task 1 — Characterization test
`frontend/src/pages/MoneyLeaksPage.test.tsx`. Mock `../lib/api` getJson for `/api/money-leaks` + `/api/money-leaks/dismissed` (read response types; return leak groups + totals + a dismissed item). Mirror SavingsRatePage.test.tsx (vi.mock, React import, ToastProvider; no router hooks — add MemoryRouter only if a render throws). Assert roles/text only: h1 title, a LeakTotals stat label, a leak-group heading or leak item. Must pass UNMODIFIED. Commit `test(money-leaks): characterization test before UI sweep`.

## Task 2 — De-drift + adopt (3 commits, test green after each)
1. static inline → tokens — `refactor(money-leaks): static inline styles -> token utilities`.
2. `.card`→Card, `.muted`→tokens, `.error`→Alert — `refactor(money-leaks): generic classes use Card/Alert + tokens`.
3. Grid + StatCard (+ EmptyState if applicable) — `refactor(money-leaks): adopt Grid/StatCard primitives`.
Preserve all data/handlers (dismiss/undismiss, currency filter, CollapsibleCard groups). Grep App.css for real rules. If StatCard can't carry the tone cleanly, keep the tile token-based + inline conditional color, report it.

## Task 3 — DoD
`grep -c "style={{" pages/MoneyLeaksPage.tsx` → 1 (the dynamic tone color) or 0 if mapped to metricKind; `grep -oE 'className="(muted|error|card|statCard|tableWrap|table|emptyState|formGrid)"' pages/MoneyLeaksPage.tsx | wc -l` → 0. `.page` may remain. lint + full suite green.

## Self-Review
13 drift→tokens; generic→primitives; Grid + StatCard adopted; 1 dynamic tone kept (or metricKind); char test guards. Low risk (no recharts/router/coupling).
