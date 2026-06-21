# Primitive Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]` checkboxes.

**Goal:** Fix the `ui/` primitive internal leaks + bugs the foundation audit logged, so the upcoming 52-page sweep builds on clean primitives — not leaky ones.

**Architecture:** Pure frontend, primitive-level. Each fix is look-preserving (or a deliberate, named visual improvement). The live `/settings/design-system` gallery is the visual reference for every change.

**Tech Stack:** React 19, Tailwind v4 token utilities, vitest. Primitives in `frontend/src/components/ui/`.

## Global Constraints
- Run from repo root: `/Users/connoradams/Developer/cashflow/.claude/worktrees/primitive-hardening`.
- Commits fail under husky unless node_modules/.bin is on PATH. Prefix exactly: `PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH git commit -m "…"` (if `-m` is blocked by sandbox lint-staged behavior, use `git commit --file=<tmpfile>`). Sole author — NEVER add Co-Authored-By.
- Color = tokens only: no hex, Tailwind token utilities or CSS custom properties that already exist.
- Reference doc: `docs/superpowers/specs/2026-06-17-ui-primitive-audit.md` (the leak list). Visual reference: `/settings/design-system`.
- DEFERRED, do NOT touch this pass: the `Card` (`p-4 sm:p-5`) + `CardContent` (`px-5 py-5`) double-pad — 81 consumers, real layout risk, gets its own task later.

---

### Task 1: Quick fixes — button secondary hover + dead token

Two independent one-line fixes, two commits.

**Files:**
- Modify: `frontend/src/components/ui/button.tsx:14`
- Modify: `frontend/src/index.css` (token block near `--accent-warm`/`--accent-green`, ~line 162)

**Interfaces:**
- Produces: a perceptible `secondary` hover; a defined `--accent-positive` token consumed by metric-stat/sparkline/pct-delta-cell.

- [ ] **Step 1: Button secondary hover**

In `button.tsx:14`, the `secondary` variant ends with `hover:opacity-90` (imperceptible on a card surface). Change that hover to a real surface shift:
```
secondary: "border border-border bg-card text-foreground hover:bg-muted",
```
(Keep the rest of the class string identical — only swap `hover:opacity-90` → `hover:bg-muted`.)

- [ ] **Step 2: Verify + commit button**

Run: `yarn workspace frontend run test button` (if a button test exists; otherwise `yarn workspace frontend run lint`). Then:
```bash
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH git commit -am "fix(ui): give Button secondary a perceptible hover (bg-muted)"
```

- [ ] **Step 3: Define the dead token**

In `frontend/src/index.css`, find the lines defining `--accent-warm: var(--primary);` and `--accent-green: var(--positive);` (~162-163). `--accent-positive` is referenced by `metric-stat.tsx:17`, `sparkline.tsx:13`, `pct-delta-cell.tsx:8` but is undefined. Add, immediately beside those siblings:
```css
  --accent-positive: var(--positive);
```
Do this in the same selector block where `--accent-warm`/`--accent-green` live. If the theme has both a light and dark `:root`/`[data-theme]` block defining `--accent-warm`, add `--accent-positive` to EACH block that defines its siblings, so it resolves in every theme.

- [ ] **Step 4: Verify the token resolves + commit**

Confirm no other definition already exists: `grep -rn "accent-positive" frontend/src/index.css`. Run `yarn workspace frontend run lint`. Then:
```bash
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH git commit -am "fix(ui): define --accent-positive token (was undefined; used by metric-stat/sparkline/pct-delta-cell)"
```

---

### Task 2: StatCard de-leak

Replace the raw App.css classes inside `StatCard` with token-utility equivalents, preserving the rendered look.

**Files:**
- Modify: `frontend/src/components/ui/stat-card.tsx:33-38`

**Interfaces:**
- Consumes: nothing new.
- Produces: a `StatCard` that renders no `.statLabel`/`.statValue`/`.statHint`/`.muted` App.css classes. 14 consumers inherit the change — look must be preserved.

- [ ] **Step 1: Determine the current effective look**

Read `stat-card.tsx:33-38` and the matching App.css rules (`grep -n 'statLabel\|statValue\|statHint' frontend/src/App.css`). Note: line 34 currently applies BOTH `statValue` (App.css `text-[1.55rem] font-semibold tracking-tight`) AND inline `text-xl font-semibold truncate` — a size conflict. Decide the canonical value size and state it in your report (default: keep the App.css size `text-[1.55rem]` since that is what renders today if App.css wins the cascade; if unsure, load `/settings/design-system` mentally against both and pick the one matching the current gallery). The goal is no visible change to existing stat cards.

- [ ] **Step 2: Swap classes for token utilities**

Replace the four lines so no App.css class remains, mapping each to its App.css definition:
- `.statLabel` (App.css: `text-[0.72rem] font-semibold uppercase tracking-normal; color var(--muted-foreground)`) → `className="text-[0.72rem] font-semibold uppercase tracking-normal text-muted-foreground"`
- `.statValue` line → keep ONE size (your Step-1 decision), `className="<chosen-size> font-semibold tracking-tight truncate"`, drop the `statValue` class and resolve the `text-xl` vs `text-[1.55rem]` conflict to the single chosen value.
- `.statHint` + `.muted` (App.css `.statHint`: `text-xs`; `.muted`: `text-sm leading-6 text-muted-foreground`) → `className="text-xs text-muted-foreground"` (statHint's `text-xs` wins the size; keep muted color).
Leave `delta`/`statDelta` markup unchanged (it already uses inline Tailwind).

- [ ] **Step 3: Verify look-preserved + commit**

Run `yarn workspace frontend run lint` and `yarn workspace frontend run test AccountsPage` (AccountsPage now renders StatCards — its characterization test must stay green). Confirm `grep -c 'statLabel\|statValue\|statHint' frontend/src/components/ui/stat-card.tsx` is 0. Then:
```bash
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH git commit -am "refactor(ui): StatCard uses token utilities, drops App.css classes"
```

---

### Task 3: EmptyState de-leak

**Files:**
- Modify: `frontend/src/components/ui/empty-state.tsx:17-18`

**Interfaces:**
- Produces: an `EmptyState` rendering no `.emptyState`/`.muted` App.css classes. 41 consumers; look must be preserved.

- [ ] **Step 1: Swap classes for token utilities**

`empty-state.tsx:17` is `<p className="emptyState mb-1 font-semibold">{title}</p>` and `:18` is `<p className="muted mb-0">{description}</p>`. App.css `.emptyState` = `m-0; color var(--muted-foreground)`; `.muted` = `text-sm leading-6 text-muted-foreground`. Replace:
- line 17 → `<p className="mb-1 font-semibold text-muted-foreground">{title}</p>`
- line 18 → `<p className="mb-0 text-sm leading-6 text-muted-foreground">{description}</p>`
Leave the wrapper div and `EmptyTableRow` unchanged.

- [ ] **Step 2: Verify + commit**

Run `yarn workspace frontend run lint` and `yarn workspace frontend run test AccountsPage` (AccountsPage uses `EmptyTableRow` → `EmptyState`). Confirm `grep -cE 'emptyState|"muted"|className="muted' frontend/src/components/ui/empty-state.tsx` shows the only remaining `emptyState` is the `EmptyTableRow`'s `emptyStateCell` td class if present (note it; that one is a layout cell class, out of scope — leave it). Then:
```bash
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH git commit -am "refactor(ui): EmptyState uses token utilities, drops App.css classes"
```

---

## Self-Review
- **Coverage:** button hover (Task 1 Step 1-2); dead token (Task 1 Step 3-4); StatCard leak (Task 2); EmptyState leak (Task 3). Card double-pad explicitly deferred. ✓
- **Placeholder scan:** every code step shows the exact before/after string. ✓
- **Look-preservation:** Tasks 2 & 3 map each dropped class to its App.css definition; the only deliberate visual change is Task 1's hover (the reported bug). ✓
- **Risk:** highest is StatCard's value-size conflict (Task 2 Step 1) — handled by an explicit decision + AccountsPage green gate + gallery reference.
