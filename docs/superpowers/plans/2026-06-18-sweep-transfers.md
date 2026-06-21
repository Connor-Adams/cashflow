# TransfersPage Sweep Plan

> REQUIRED SUB-SKILL: superpowers:subagent-driven-development. cashflow-ui-sweep Mode-A.

**Goal:** De-drift `frontend/src/pages/TransfersPage.tsx` (659 lines; 8 inline = 7 static + 1 dynamic warn color, generic `.card`/`.muted`/`.error`/`.tableWrap`/`.table`) + adopt DS primitives. Char-test guarded. Keep the 1 dynamic tone color. No `.transactions*` quartet, no recharts, no coupling.

## Constraints
Worktree `/Users/connoradams/Developer/cashflow/.claude/worktrees/sweep-transfers` (node_modules symlinked). Commit `PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH git commit …` (or `--file`). Sole author, no Co-Authored-By. Token-only; grep App.css for real rules. **Run `yarn workspace frontend run build` before pushing** (vitest doesn't typecheck).

## Scope
- 7 static inline → token utilities: the 2 filter flex rows `{display:flex,gap:12,alignItems:center,marginBottom:12}` → `flex items-center gap-3 mb-3`; `padding:8`→`p-2`; `fontSize:12`→`text-xs`; footer `{marginTop:8,fontSize:12}`→`mt-2 text-xs`. The stat grid `repeat(auto-fit,minmax(180px,1fr))` → Grid (Step 3). The stat box `{padding:12,border:1px solid var(--border),borderRadius:6}` → StatCard (Step 3).
- KEEP dynamic: Stat value `color: tone==='warn' ? 'var(--accent-warm)' : undefined` — keep inline OR carry via StatCard (map tone; or `text-[var(--accent-warm)]` arbitrary class like MoneyLeaks).
- `.card`→`<Card>`; `.muted`→`text-sm leading-6 text-muted-foreground` (size per context); `.error`→`<Alert variant="error">`. Keep `.page`.
- `.tableWrap`+`.table` (generic, ×3 tables) → the `<Table>` primitive (drop the wrapper div + classes; Table self-wraps). Sticky inside CollapsibleCard is preserved by the widened `[data-slot="collapsible-card"] [data-slot="table-head"]` selector (from #670). EmptyTableRow already used — keep.
- Adopt: stat grid → `<Grid minItemWidth={180} gap="md">`; Stat tiles → `<StatCard label value>` (warn tone via metricKind or arbitrary class). CollapsibleCard stays.

## Task 1 — Characterization test
`frontend/src/pages/TransfersPage.test.tsx`. Mock `../lib/api` getJson for `/api/transfers/stats`, `/api/transfers/unmatched`, `/api/transfers/money-movement` (read response types; return stats + an unmatched row + a money-movement row). Stub postJson/patchJson. Mirror SavingsRatePage.test.tsx (vi.mock, React import, ToastProvider; no router hooks — add MemoryRouter only if a render throws). Assert roles/text only: h1 title, a TransferStats stat label, a table column header or an unmatched-row cell. Must pass UNMODIFIED. Commit `test(transfers): characterization test before UI sweep`.

## Task 2 — De-drift + adopt (3 commits, test green after each)
1. static inline → tokens — `refactor(transfers): static inline styles -> token utilities`.
2. `.card`→Card, `.muted`→tokens, `.error`→Alert, `.tableWrap`/`.table`→Table primitive — `refactor(transfers): generic classes use Card/Alert/Table + tokens`.
3. Grid + StatCard (stat grid + tiles) — `refactor(transfers): adopt Grid/StatCard`.
Preserve all data/handlers (link/unlink/purpose mutations, suggestion expander, the nested suggestion Table). Grep App.css for real rules.

## Task 3 — DoD
`grep -c "style={{" pages/TransfersPage.tsx` → 1 (dynamic tone) or 0 if mapped; `grep -oE 'className="(muted|error|card|statCard|tableWrap|table|emptyState|formGrid)"' pages/TransfersPage.tsx | wc -l` → 0. `.page` may remain. lint + `frontend build` + full suite green.

## Self-Review
7 drift→tokens; generic→primitives; Grid+StatCard; Table primitive (sticky preserved via widened selector); 1 dynamic kept; char test guards. Low risk (no coupling/recharts/quartet).
