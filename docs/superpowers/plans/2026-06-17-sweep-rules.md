# RulesPage Sweep Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]` checkboxes.

**Goal:** UI sweep of `frontend/src/pages/RulesPage.tsx` (711 lines) + its sibling `frontend/src/components/RulesHealthSection.tsx` (307 lines) — de-drift the 8 static inline styles + the generic legacy classes, adopt the DS primitives (SectionHeader, Card, Grid, StatCard, Alert, Table), and remove cross-page coupling (borrowed `.transactions*` classes). Guarded by the EXISTING `RulesPage.test.tsx` (121 lines).

**Architecture:** Pure frontend. Both files already use Table/Button/PageHeader/Dialog. The drift is generic classes + a few static inline styles + bespoke `rules*` aliases. The RulesHealthSection has the stat grid + card headers that map to Grid/StatCard/SectionHeader.

**Tech Stack:** React 19, Tailwind v4, vitest. References (merged): the Savings/Lifestyle/Calendar sweeps; Grid/SectionHeader/StatCard primitives; `docs/ui-rules.md`.

## Global Constraints
- Run from repo root: `/Users/connoradams/Developer/cashflow/.claude/worktrees/sweep-rules` (node_modules symlinked — `yarn workspace frontend run test` works).
- Commit husky workaround, exact prefix: `PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH git commit -m "…"` (if `-m` blocked, `git commit --file=<tmpfile>`). Sole author — NEVER add Co-Authored-By.
- Color = tokens only: no hex; map each dropped class to its ACTUAL App.css rule (grep — don't trust quotes).
- **CRITICAL — keep the `.isFocused` class** on the rule row: `RulesPage.test.tsx` asserts the focused row gets `.isFocused` (it drives a keyframe animation). Do NOT remove/rename it. The existing test is the safety net — run it after every commit.
- De-drift look-preserving; SectionHeader/StatCard adoption deliberate standardizations — note them.

## Scope
- **Migrate (drift):** 8 static inline styles (`fontSize:12`→`text-xs`; `fontStyle:'italic'`→`italic`; `color:'var(--color-destructive)'`→`text-destructive` token; `marginLeft:8`→`ml-2`; `gridColumn:'1 / -1'`→`col-span-full`). `.muted`(×10)→`text-sm leading-6 text-muted-foreground` (margins per context; some are `text-xs` already-paired — keep xs). `.error`→`<Alert variant="error">`. `.card`+`.rulesFormCard`/`.rulesTableCard`→`<Card className="mb-4">` (the rules* aliases are `@apply mb-4`/`mb-0` — confirm via grep). `.formGrid`+`.rulesFormGrid`→`mb-3 grid gap-3 grid-cols-[…]` (confirm the rulesFormGrid template via App.css). `<table className="table">`/`.tableWrap`→`Table` primitive (the page already imports Table primitives — reconcile: drop `.table`/`.tableWrap`/`.transactionsTableWrap`/`.transactionsTable` and use the `<Table>` primitive's self-wrapping). `.emptyStateCell`→`EmptyTableRow`/`EmptyState`.
- **Adopt:** `.rulesCardHeader` (×3 in RulesPage + in RulesHealthSection)→`<SectionHeader>`; the RulesHealthSection stat grid→`<Grid>`+`<StatCard>`.
- **KEEP (bespoke, leave + note):** `.ruleRow`/`.isFocused` (keyframe animation — TEST DEPENDS ON `.isFocused`); `.transactionsPanelBadge` (×4 — bespoke badge borrowed from Transactions; leave or note as a future Badge-variant consolidation); `.rulesCategoryField`/`.rulesCategoryPicker*` (CategoryCloudPicker wrapper). `.page` kept.
- Aria: the inline error spans (~432, ~512) have `role="alert"` — if you convert any to `<Alert variant="error">`, Alert provides role; for FIELD-level validation errors wired to inputs keep them as `text-destructive` spans with their role/id.

## Files
RulesPage.tsx (primary) + RulesHealthSection.tsx (stat grid + headers). Do BOTH so the `rules*` classes can later be removed from App.css.

---

### Task 1: Verify the existing safety net

**Files:** none (read-only).

- [ ] **Step 1:** `yarn workspace frontend run test RulesPage` → confirm the existing 4 tests pass on the untouched base. If red on base, STOP and report. This is the green gate for Task 2.

---

### Task 2: De-drift + primitive adoption (both files)

Several focused commits, each keeping `RulesPage.test.tsx` green (run after EACH).

**Files:** Modify `frontend/src/pages/RulesPage.tsx`, `frontend/src/components/RulesHealthSection.tsx`

- [ ] **Step 1: Static inline styles → tokens** (commit `refactor(rules): static inline styles -> token utilities`)

The 8 inline styles → utilities per the Scope mapping (`text-xs`, `italic`, `text-destructive`, `ml-2`, `col-span-full`). Keep `role="alert"` on the error spans. Run test green.

- [ ] **Step 2: Generic classes → primitives/tokens** (commit `refactor(rules): generic classes use Card/Alert/Table/SectionHeader + tokens`)

`.muted`→tokens; `.error`→`<Alert variant="error">`; `.card`+`rulesFormCard`/`rulesTableCard`→`<Card className="mb-4">`/`mb-0`; `.formGrid`+`rulesFormGrid`→arbitrary grid classes (grep App.css for the real templates); `.tableWrap`/`.transactionsTableWrap`+`.table`/`.transactionsTable`→`<Table>` primitive (drop the classes, use the primitive's self-wrap); `.emptyStateCell`→`<EmptyTableRow>`; `.rulesCardHeader`→`<SectionHeader>`. Grep App.css for each real rule body. KEEP `.ruleRow`/`.isFocused`, `.transactionsPanelBadge`, `.rulesCategory*`. Run test green.

- [ ] **Step 3: RulesHealthSection — Grid + StatCard + SectionHeader** (commit `refactor(rules-health): adopt Grid/StatCard/SectionHeader`)

In `RulesHealthSection.tsx`: the stat grid (4 stat tiles)→`<Grid minItemWidth={…} gap="md">` of `<StatCard>`s; `.rulesCardHeader`→`<SectionHeader>`; any `.muted`/`.card` there → tokens/Card. Deliberate standardization for the StatCards — note it. Run `yarn workspace frontend run test RulesPage` (RulesHealthSection renders within RulesPage's tree if mounted) + any RulesHealthSection.test if present — green.

- [ ] **Step 4: Verify after each commit** — test green; `yarn workspace frontend run lint` clean.

---

### Task 3: DoD verification

**Files:** `docs/ui-rules.md` only if a bespoke class needs logging.

- [ ] **Step 1: Verify** (from `frontend/src`):
```bash
grep -c "style={{" pages/RulesPage.tsx          # expect 0 (all 8 were static drift)
grep -oE 'className="[^"]*(\bmuted\b|\berror\b|\bcard\b|formGrid|tableWrap|\btable\b|emptyStateCell|rulesCardHeader|rulesFormCard|rulesTableCard|rulesFormGrid)[^"]*"' pages/RulesPage.tsx | wc -l   # expect 0 (these all migrated)
```
Note the false-positive trap: `\bcard\b` won't match `bg-card`/`text-card-foreground`? It will — beware; grep precisely or eyeball. Expect remaining only: `.page`, `.ruleRow`/`.isFocused`, `.transactionsPanelBadge`, `.rulesCategory*` (bespoke, kept). Log the kept bespoke classes in `docs/ui-rules.md` "Rule gaps / deferred bespoke (RulesPage)".

- [ ] **Step 2: Full gates** — `yarn workspace frontend run lint` clean; `yarn workspace frontend run test RulesPage` green; broad `yarn workspace frontend run test --run` green. Commit the doc edit:
```bash
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH git commit -am "docs(ui): log RulesPage deferred bespoke classes"
```

---

## Self-Review
- **Coverage:** existing test verified (T1); 8 inline + generic classes → tokens/primitives across both files + Grid/StatCard/SectionHeader adoption (T2); DoD + log (T3). ✓
- **Test-coupling guard:** `.isFocused` kept (test asserts it). ✓
- **Coupling fix:** borrowed `.transactions*` table classes dropped for the Table primitive; `.transactionsPanelBadge` left (bespoke badge) + logged for future Badge-variant consolidation. ✓
- **Risk:** medium — two files, the `.table`/`.tableWrap`→Table-primitive reconciliation (the page imports Table primitives but also uses raw `.table` class — confirm which markup is raw vs primitive), and preserving the focus-row test. The existing test guards the focus behavior; run it after every commit.
