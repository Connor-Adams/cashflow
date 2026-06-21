# AmazonPage Sweep Plan (partial)

> REQUIRED SUB-SKILL: superpowers:subagent-driven-development. cashflow-ui-sweep Mode-A (partial — keep bespoke + dynamic).

**Goal:** Migrate the generic-utility drift on `frontend/src/pages/AmazonPage.tsx` (614 lines) to DS primitives/tokens. Keep the 2 dynamic confidence-color inline styles and the bespoke `amazon*` layout classes (page-specific, no primitive fits — log them). Relaxed DoD: no generic-utility drift. Guarded by the existing AmazonPage.test.tsx (augmented).

## Constraints
Worktree `/Users/connoradams/Developer/cashflow/.claude/worktrees/sweep-amazon` (node_modules symlinked). Commit `PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH git commit …` (or `--file`). Sole author, no Co-Authored-By. Token-only; grep App.css for real rules. **Run `yarn workspace frontend run build` before pushing.**

## Scope
- MIGRATE (generic drift): `.card`(×6)→`<Card>`; `.muted`(×7)→`text-sm leading-6 text-muted-foreground` (size per context); `.error`→`<Alert variant="error">` (block errors; field-level validation error wired to the totalPrice input → keep as `text-danger` span with its id/role — the existing test asserts that error, do NOT break it); `.tableWrap`+`.table` (×2 tables, generic non-sticky) → the `<Table>` primitive (drop wrapper + class; Table self-wraps).
- ADOPT if applicable: `amazonSummaryGrid` (the summary stat grid, ~403-410) — if it's an auto-fit stat grid, → `<Grid minItemWidth=…>` + `<StatCard>` for the tiles; if it's a bespoke non-stat layout, leave it.
- KEEP (log in docs/ui-rules.md "deferred bespoke"): the 2 DYNAMIC confidence-color inline styles (`color: confidenceColor(pct)` ~429, ~599 — truly computed); bespoke `amazon*` layout classes (amazonPage, amazonHeader, amazonActionRow, amazonImportPanel, amazonReviewList, amazonReviewRow, amazonSuggestedLink, amazonManualLink, amazonOrderEditor, amazonLinks).

## Task 1 — Augment the characterization test
The existing `frontend/src/pages/AmazonPage.test.tsx` (3 tests, totalPrice validation only) is a partial safety net. ADD ~2-3 role/text-only characterization assertions that the migration must preserve: the h1 title, a summary stat label/value, and an orders-table column header. Keep the existing validation tests intact (they assert the totalPrice field error — KEEP that error element/behavior). Run `yarn workspace frontend run test AmazonPage` → all green UNMODIFIED. Commit `test(amazon): add characterization assertions before UI sweep`.

## Task 2 — De-drift + adopt (commits, test green after each)
1. `.card`→Card, `.muted`→tokens, `.error`→Alert (block) / text-danger (field) — `refactor(amazon): generic classes use Card/Alert + tokens`.
2. `.tableWrap`/`.table`→Table primitive (×2) — `refactor(amazon): tables use Table primitive`.
3. `amazonSummaryGrid`→Grid+StatCard IF it's a stat grid — `refactor(amazon): summary uses Grid/StatCard` (skip this commit if it's not a clean stat grid).
Preserve all data/handlers (import form, review/link flow, order editor modal, totalPrice validation). Grep App.css for real rules. KEEP the 2 dynamic colors + bespoke amazon* classes.

## Task 3 — DoD + log
`grep -oE 'className="(muted|error|card|statCard|tableWrap|table|emptyState|formGrid)"' pages/AmazonPage.tsx | wc -l` → 0 (generic drift gone). `grep -c "style={{" pages/AmazonPage.tsx` → 2 (the dynamic confidence colors — confirm). Bespoke amazon* remain (expected). Append to `docs/ui-rules.md` a one-line "AmazonPage deferred bespoke: amazon* layout classes + 2 dynamic confidenceColor() inline styles". lint + `frontend build` + full suite green. Commit the doc.

## Self-Review
Generic drift→primitives/tokens; tables→Table; bespoke amazon* + 2 dynamic colors kept + logged; existing test augmented + preserved (incl. totalPrice field error). Partial DoD (no generic-utility drift). Low risk (no coupling/recharts/quartet).
