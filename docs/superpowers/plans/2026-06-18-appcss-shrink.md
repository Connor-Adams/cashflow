# App.css Shrink Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Per-page sweep tasks (Phase 2) REQUIRE the `cashflow-ui-sweep` skill.

**Goal:** Shrink `frontend/src/App.css` from a 2167-line monolith toward a small global base layer, by deleting dead rules and sweeping page-scoped raw CSS onto design-system primitives + Tailwind utilities.

**Architecture:** This is a *shrink*, not a *split*. The repo already committed to Tailwind v4 + design-system primitives (primitives spine, `cashflow-ui-sweep` skill, Tree primitive). Splitting App.css into per-area files would entrench the CSS-file pattern we're leaving and do the work twice. Instead: (1) purge dead rules, (2) eliminate the one genuinely-raw block (Enrichment tab), (3) sweep the remaining `@layer components` classes page-by-page onto primitives/utilities. Whatever survives is the legitimately-global `@layer base` reset layer (~46 lines) — that stays one file.

**Tech Stack:** Vite + React 19, Tailwind v4 (`@layer`, `@apply`, `@theme`), Radix, lucide. Frontend tests: vitest. Tokens live in `index.css`; App.css owns component classes only.

## Global Constraints

- Prefer Tailwind utilities over raw CSS. Variant class maps must use **literal** strings (JIT needs literals) — never interpolate class names. (Per `feedback_prefer_tailwind_over_raw_css`.)
- Do **not** delete a class on assumed redundancy — verify each against code first. (Per `feedback_dont_trim_tools_on_assumed_redundancy`.) Dynamic classes are built via lookup maps (e.g. `BudgetStatusCard.tsx:139` `pillClass[status]`) and `template${literals}` (e.g. `Sidebar.tsx:272`) — bare-string grep misses these.
- Run everything from repo root (yarn-1 workspace hoist). Verify command: `yarn workspace frontend run build` must compile (a missing `@apply` source class is a build error, so the build is a real guard).
- CSS edits have no unit test. Per-task verification = typecheck + frontend test suite + production build + visual check via the `run` skill on the affected page. "Evidence before assertions."
- One PR per task. Auto-merge, merge commit, no squash. No `Co-Authored-By`.

---

## File Structure

- `frontend/src/App.css` — shrinks across every task. End state: `@layer base` resets + whatever truly-global component classes remain.
- `frontend/src/index.css` — design tokens (`--foreground`, etc.). **Not touched.**
- `frontend/src/components/ds/*` — design-system primitives. Phase 2 sweeps create/extend these when a raw block is a reusable pattern.
- Per-page component files — gain inline Tailwind `className`s as classes move out of App.css.

App.css anatomy (current):
| Region | Lines | Nature | Disposition |
|---|---|---|---|
| `@layer base` | 1–46 | button/input safety-net resets | **Keep** |
| `@layer components` | 47–~1831 | ~280 classes, mostly `@apply` + some raw `var(--)` | Phase 2 page sweeps |
| `.ruleRow.isFocused td` | 1832 | stray raw rule | fold into Phase 2 (rules page) |
| `.enrich*` block | 1842–2167 | ~50 classes, pure raw CSS, one settings tab | **Phase 1** |

---

## Task 1: Purge dead classes

**Files:**
- Modify: `frontend/src/App.css` (delete confirmed-dead rule blocks)

**Interfaces:**
- Consumes: nothing.
- Produces: a smaller App.css. No exported symbols.

**Candidate dead list (45 — base-token-zero, safe pending per-class confirm):**

```
accountsActionGroup accountsStats accountsTableCard
aiInboxExpandToggle aiInboxItem aiInboxItemActions aiInboxItemDetail
aiInboxItemDetailLink aiInboxItemDetails aiInboxItemSummary aiInboxList
aiInboxPage aiInboxTabCount aiInboxTabs
aiVisibilityAction aiVisibilityMore aiVisibilitySupportingIds
amazonSummaryGrid buttonLikeLink chartWrap
dashboardBusinessSpotlight dashboardChartCard dashboardFilters dashboardStats dashboardTableCard
filePick parseErrorList previewBlock
reportsFilters reportsGrid reportsStats reportsTableCard
rulesCardHeader rulesFormCard rulesFormGrid rulesTableCard
transactionsActionRow transactionsFilterGrid transactionsHelperCopy transactionsPager
transactionsToolbar transactionsToolbarMeta transactionsTopGrid
unreadDot uploadCard
```

**Risky — needs manual judgment, NOT in the blind-delete set (5):**
`budgetPill--over`, `budgetPill--warn` (built in `BudgetStatusCard.tsx` `pillClass` map), `businessFocusCard--business`, `businessFocusCard--personal`, `is-unread` (token `unread` live in 7 files). Resolve each: if the base class is still rendered and the variant is genuinely unreachable, delete just the variant; otherwise keep.

- [ ] **Step 1: Regenerate the dead list (don't trust this doc — verify live)**

Run:
```bash
cd frontend/src
grep -oE '\.[a-zA-Z][a-zA-Z0-9_-]+' App.css | sed 's/^\.//' | sort -u > /tmp/all.txt
while IFS= read -r c; do
  grep -rqF "$c" --include=*.tsx --include=*.ts --include=*.jsx . 2>/dev/null || {
    base=$(echo "$c" | sed -E 's/^is-//; s/--.*$//')
    grep -rqF "$base" --include=*.tsx --include=*.ts --include=*.jsx . 2>/dev/null || echo "$c"
  }
done < /tmp/all.txt
```
Expected: ~45 class names. This is the confirmed-safe set (base token appears nowhere in code).

- [ ] **Step 2: Spot-confirm the `aiInbox*` cluster (highest false-positive risk)**

The legacy AI Inbox page was replaced by `pages/UnifiedInboxPage.tsx`. Confirm the old `aiInbox*` rules are truly orphaned:
```bash
cd frontend/src
grep -rn "aiInbox" --include=*.tsx --include=*.ts .
```
Expected: zero `className` usages of the listed `aiInbox*` classes (any hits are unrelated strings/ids). If a class IS rendered, drop it from the delete set.

- [ ] **Step 3: Delete confirmed-dead rule blocks from App.css**

For each confirmed class, remove its full rule block (selector + body + any `--variant`/`:hover`/`:last-child` companions). Leave section comments only if other live classes remain under them.

- [ ] **Step 4: Resolve the 5 risky variants**

For each of `budgetPill--over/--warn`, `businessFocusCard--business/--personal`, `is-unread`: open the referencing file, confirm whether the variant is reachable. Keep if reachable, delete the variant rule only if not. Document the call inline in the PR description.

- [ ] **Step 5: Verify build + tests + typecheck**

Run:
```bash
yarn workspace frontend run typecheck
yarn workspace frontend run test
yarn workspace frontend run build
```
Expected: all pass. Build proves no surviving `@apply` referenced a deleted class.

- [ ] **Step 6: Visual smoke on touched pages**

Use the `run` skill: launch the app, eyeball Dashboard, Transactions, Reports, Accounts, Rules, Unified Inbox. Expected: no layout regressions (these classes were dead, so there should be none — this confirms the dead-call).

- [ ] **Step 7: Commit**

```bash
git add frontend/src/App.css
git commit -m "refactor(frontend): purge dead App.css classes"
```

---

## Task 2: Sweep the Enrichment tab off raw CSS

**Files:**
- Modify: `frontend/src/App.css` (delete `.enrich*` block, lines ~1842–2167)
- Modify: `frontend/src/pages/settings/tabs/EnrichmentTab.tsx`, `pages/settings/tabs/enrichment/{EnrichmentBackfillCard,EnrichmentTopLists,EnrichmentSourceChart,EnrichmentConfidenceChart,EnrichmentStatRow}.tsx`, `pages/settings/tabs/imports/{CounterpartyBackfillCard,InteracSyncCard}.tsx`
- Possibly Create: a primitive under `frontend/src/components/ds/` if a repeated enrich pattern (e.g. the stat tile / confidence bar / source bar) is reuse-worthy
- Test: existing `pages/settings/tabs/enrichment/{EnrichmentStatRow,EnrichmentSourceChart}.test.tsx` guard behavior

**Interfaces:**
- Consumes: existing tokens from `index.css`, existing `ds/` primitives.
- Produces: zero `.enrich*` classes in App.css; any new primitive exported from `components/ds`.

**Why this block first:** it's the only large *pure-raw* (non-`@apply`, non-`@layer`) block — ~325 lines for a single settings subsystem, confined to ~8 files. Self-contained, highest raw-CSS payoff, has existing tests as a safety net.

- [ ] **Step 1: Invoke the sweep skill**

Use the `cashflow-ui-sweep` skill with target = Enrichment settings tab. It maps each `.enrich*` class to a primitive or Tailwind utility set. Follow its method; do not hand-roll.

- [ ] **Step 2: Identify reuse-worthy patterns before converting**

Within the enrich block, flag repeated structures (`enrichWorkflowTile`, `enrichStatGrid`, `enrichConfidenceBar`, `enrichSourceBar`, `enrichListCard`). A pattern used 2+ times → extract a `ds/` primitive (per the primitives spine build rule). A one-off → inline Tailwind utilities on the component.

- [ ] **Step 3: Convert components, deleting each class from App.css as it's migrated**

Move styles inline (or into the new primitive) per the skill's output. Keep variant maps literal (e.g. `const toneClass = { amber: 'border-amber-500 ...' }`), never interpolated.

- [ ] **Step 4: Delete the now-empty `.enrich*` block from App.css**

```bash
cd frontend/src
grep -nE '^\.enrich' App.css
```
Expected: no output (all gone).

- [ ] **Step 5: Verify**

```bash
yarn workspace frontend run typecheck
yarn workspace frontend run test
yarn workspace frontend run build
```
Expected: all pass, including the enrichment component tests.

- [ ] **Step 6: Visual confirm the Enrichment tab**

Use the `run` skill: open Settings → Enrichment. Compare against pre-sweep (stat grid, confidence bar, source bars, top-lists, backfill feed). Expected: pixel-equivalent.

- [ ] **Step 7: Commit**

```bash
git add frontend/src
git commit -m "refactor(frontend): sweep Enrichment tab off raw App.css onto primitives"
```

---

## Task 3..N: Page-by-page `@layer components` sweep (repeatable)

**This is the long tail.** Everything left in `@layer components` is `@apply`-based (Tailwind centralized in a CSS file) with some raw `var(--)` properties mixed in. Eliminating it is real work but YAGNI says do it page-by-page as each page is touched, not in one mega-PR. Each section below is an independent task: same playbook, own PR, own review gate.

**Per-section playbook (apply to each backlog row):**

- [ ] **Step 1:** Invoke `cashflow-ui-sweep` with the section's page/feature as target.
- [ ] **Step 2:** For each class in the section: `@apply`-only class used once → inline the utilities on the component and delete the class; class with raw `var(--)` properties → convert to utilities (`text-[var(--foreground)]`, etc.) or a primitive; repeated pattern → extract/extend a `ds/` primitive.
- [ ] **Step 3:** Delete migrated classes from App.css; remove the section comment when empty.
- [ ] **Step 4:** Verify — `yarn workspace frontend run typecheck && yarn workspace frontend run test && yarn workspace frontend run build`.
- [ ] **Step 5:** Visual confirm the page via the `run` skill against pre-sweep.
- [ ] **Step 6:** Commit — `refactor(frontend): sweep <section> off App.css`.

**Backlog (ordered by isolation — most self-contained first; line numbers drift as earlier tasks land, re-grep the section comment each time):**

| # | Section (comment anchor) | ~Line | Notes |
|---|---|---|---|
| 3 | Bento dashboard tile chrome → Dashboard table card | 1413–1831 | KpiStack, Top growers, Recurring, Currency mix, TableTile, Budget pills, Dashboard table card — one cohesive dashboard cluster; includes the stray `.ruleRow.isFocused td` (1832) |
| 4 | AI Inbox page | 943–1040 | verify against UnifiedInboxPage after Task 1's aiInbox purge |
| 5 | Dashboard insight card helpers | 1073–1412 | |
| 6 | reviewInbox / decision card / shortcut hint / chip | 501–942 | shared chip patterns — strong primitive-extraction candidates |
| 7 | table / sticky thead | 347–500 | likely already a `Table` primitive target (Tree primitive precedent) |
| 8 | Brand pieces | 202–346 | sidebar reuses — check before moving |
| 9 | Sidebar + nav badge + button-like anchor | 88–201, 1041–1072 | uses `template${literal}` classes (`Sidebar.tsx:272`) — keep variant logic literal |
| 10 | Layout shell | 48–87 | app-level grid; may legitimately stay if truly global |

**Stop condition:** when only `@layer base` (1–46) + any genuinely-global shell classes remain. That residue is the legitimate one-file end state. Do **not** split it further.

---

## Self-Review

**Spec coverage:** purge dead (Task 1) ✓; eliminate raw block (Task 2) ✓; convert remaining to Tailwind/primitives (Tasks 3–N) ✓; "break it up" reframed as shrink with rationale in Architecture ✓; keep global base ✓.

**Placeholder scan:** Phase 2 uses a repeatable template rather than spelling out ~280 class conversions — this is deliberate scoping, not a placeholder: the per-page diff is generated by `cashflow-ui-sweep` at execution, and each backlog row names exact section + line range. Tasks 1–2 are fully concrete.

**Type/name consistency:** no cross-task symbols beyond optional `ds/` primitives, which each task defines and exports locally; variant maps constrained to literal strings per Global Constraints.

**Risk register:** dead-class false positives (lookup maps, template literals) — mitigated by Task 1 base-token re-grep + manual confirm of the 5 risky + aiInbox spot-check. CSS has no unit test — mitigated by build-as-guard + existing component tests + visual smoke per task.
