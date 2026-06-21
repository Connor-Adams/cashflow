# Palette Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Cashflow's muted amber/plum/jade/rust palette with a greyscale + oxblood + orange→pink-gradient system across both light and dark mode, migrate all hardcoded Tailwind color utilities to semantic tokens, and ship a live palette reference page under Settings.

**Architecture:** `frontend/src/index.css` holds a three-layer token tree — raw ramp vars (`--amber-500` …) → semantic vars (`--primary`, `--positive` …) → Tailwind `@theme inline` mapping (`--color-*`). Raw ramp vars are referenced ONLY inside `index.css` (verified: 0 external refs), so we swap their values freely. Components instead reach for Tailwind's *built-in* `amber-*`/`emerald-*`/`red-*` utilities because the token system never exposed semantic color utilities; we add those utilities, then migrate. A new Settings section reads the live tokens via `getComputedStyle`.

**Tech Stack:** Tailwind v4 (`@theme inline`), React 19, react-router-dom v7, vitest + Testing Library. Spec: `docs/superpowers/specs/2026-06-17-palette-greyscale-oxblood-redesign-design.md`.

---

## File Structure

- `frontend/src/index.css` — **all** token changes: ramp values, semantic mappings (light `:root[data-theme="light"]` + dark `:root[data-theme="dark"]`), new `--gradient-hero`, new `warning` ramp, new `@theme inline` semantic color utilities. Single source of truth.
- `frontend/src/App.css` — remove 3 off-palette hardcoded sites.
- `frontend/src/components/**`, `frontend/src/pages/**` — migrate hardcoded `amber-*` / `emerald-*` / `red-*` / `orange-*` Tailwind utilities to semantic utility classes (28 files).
- `frontend/src/pages/settings/sections/PaletteSection.tsx` — **new** live palette reference (read tokens at runtime).
- `frontend/src/pages/settings/sections/PaletteSection.test.tsx` — **new** test.
- `frontend/src/App.tsx` — register the new Settings section.
- `frontend/src/pages/settings/useActiveSettingsTopTab.ts` — add the tab id if the nav requires it.
- `frontend/test/` or colocated — a guard test asserting no off-palette literals remain.

> **Commit hooks:** this worktree has no `node_modules`. Prefix every `git commit` with
> `PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH` so husky/lint-staged resolves.
> Run all `yarn` commands from the **repo root**.

---

## Phase 1 — Token foundation (index.css)

### Task 1: Add the new raw ramps (keep old ones temporarily)

**Files:**
- Modify: `frontend/src/index.css` (inside `:root, :root[data-theme="light"]`, after `--radius`)

- [ ] **Step 1: Add the new ramp blocks** at the top of the light `:root` block, BEFORE the existing `/* Amber / Primary */` block (do not delete old ramps yet — semantic vars still point at them this task):

```css
  /* ── NEW PALETTE RAMPS ─────────────────────────────────────────── */
  /* Greyscale (zinc) — the workhorse */
  --zinc-50:  #FAFAFA;
  --zinc-100: #F4F4F5;
  --zinc-200: #E4E4E7;
  --zinc-300: #D4D4D8;
  --zinc-400: #A1A1AA;
  --zinc-500: #71717A;
  --zinc-600: #52525B;
  --zinc-700: #3F3F46;
  --zinc-800: #27272A;
  --zinc-900: #18181B;
  --zinc-950: #09090B;

  /* Oxblood — signature + money-out + danger */
  --oxblood-50:  #FBEDEE;
  --oxblood-100: #F6D6D9;
  --oxblood-200: #E9A8AF;
  --oxblood-300: #DA7B85;
  --oxblood-400: #C44E5B;
  --oxblood-500: #9B2D3A;
  --oxblood-600: #82252F;
  --oxblood-700: #661C26;
  --oxblood-800: #4A141B;
  --oxblood-900: #2E0C10;

  /* Green — money-in / positive */
  --green-100: #D1FAE5;
  --green-200: #7DDCAE;
  --green-300: #35BE83;
  --green-500: #0FA06C;
  --green-600: #0A875D;
  --green-700: #086F4C;

  /* Amber — warning / caution ONLY (not a brand color) */
  --amber-w-100: #FEF3C7;
  --amber-w-300: #F5C451;
  --amber-w-500: #D9A441;
  --amber-w-700: #B45309;

  /* Hero gradient */
  --gradient-hero: linear-gradient(135deg, #FF7847, #E84393);
  --gradient-hero-from: #FF7847;
  --gradient-hero-to:   #E84393;

  /* Chart categorical extras */
  --chart-steel: #5EA8E0;
```

- [ ] **Step 2: Typecheck/build sanity** — CSS only, so run the frontend build to confirm no parse error.

Run: `yarn workspace frontend run build`
Expected: build succeeds (tokens added, nothing references them yet).

- [ ] **Step 3: Commit**

```bash
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH git add frontend/src/index.css
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH git commit -m "feat(palette): add greyscale/oxblood/green/amber-warning ramps + gradient token"
```

---

### Task 2: Repoint LIGHT semantic tokens to the new ramps

**Files:**
- Modify: `frontend/src/index.css` — the semantic section of `:root, :root[data-theme="light"]` (surfaces, text, brand, accent, links, signals, borders, charts)

- [ ] **Step 1: Replace the light semantic assignments** with these exact values (match each existing token name; do not invent new names except `--gradient-hero` already added and `--warning`/`--positive`/`--negative` which already exist):

```css
  /* Surfaces */
  --background: var(--zinc-100);   /* #F4F4F5 */
  --card: #FFFFFF;
  --popover: #FFFFFF;
  --muted: var(--zinc-100);

  /* Text */
  --foreground: var(--zinc-900);   /* #18181B */
  --card-foreground: var(--foreground);
  --popover-foreground: var(--foreground);
  --muted-foreground: var(--zinc-500);  /* #71717A */

  /* Brand */
  --primary: var(--oxblood-500);
  --primary-hover: var(--oxblood-600);
  --primary-foreground: #FFFFFF;

  /* Accent (hero gradient lives in --gradient-hero; --accent kept for tinted surfaces) */
  --accent: var(--oxblood-50);
  --accent-foreground: var(--oxblood-700);

  /* Links */
  --text-link: var(--oxblood-600);
  --text-link-hover: var(--oxblood-700);

  /* Semantic signals */
  --success: var(--green-600);
  --success-bg: var(--green-100);
  --success-foreground: var(--green-700);
  --warning: var(--amber-w-700);
  --warning-bg: var(--amber-w-100);
  --warning-foreground: var(--amber-w-700);
  --danger: var(--oxblood-500);
  --danger-bg: var(--oxblood-50);
  --danger-foreground: var(--oxblood-700);
  --positive: var(--green-600);
  --positive-foreground: #FFFFFF;
  --negative: var(--oxblood-500);
  --destructive: var(--oxblood-500);
  --destructive-foreground: #FFFFFF;

  /* Borders / structural */
  --secondary: var(--zinc-100);
  --secondary-hover: var(--zinc-200);
  --secondary-foreground: var(--zinc-900);
  --border: var(--zinc-200);       /* #E4E4E7 */
  --input: var(--zinc-300);
  --ring: var(--oxblood-500);
  --shadow: 0 8px 18px rgb(9 9 11 / 0.08);
```

- [ ] **Step 2: Replace the light chart assignments** (the `--chart-*` block):

```css
  --chart-1: var(--oxblood-500);
  --chart-2: var(--green-600);
  --chart-3: var(--gradient-hero-to);   /* pink */
  --chart-4: var(--gradient-hero-from);  /* orange */
  --chart-5: var(--zinc-400);
  --chart-spend: var(--oxblood-500);
  --chart-credit: var(--green-600);
  --chart-payment: var(--zinc-500);
  --chart-business: var(--chart-steel);
  --chart-personal: var(--positive);
  --chart-line-1: var(--primary);
  --chart-line-2: var(--positive);
  --chart-line-3: var(--chart-steel);
  --chart-line-4: var(--destructive);
  --chart-line-5: var(--amber-w-300);
  --chart-line-6: var(--oxblood-300);
```

Leave the `--chart-income`, `--chart-category` etc. extended block AS-IS for now (handled in Task 7).

- [ ] **Step 3: Build + eyeball light mode**

Run: `yarn workspace frontend run build`
Expected: build succeeds.

- [ ] **Step 4: Commit**

```bash
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH git add frontend/src/index.css
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH git commit -m "feat(palette): repoint light semantic tokens to new ramps"
```

---

### Task 3: Repoint DARK semantic tokens

**Files:**
- Modify: `frontend/src/index.css` — `:root[data-theme="dark"]` block

- [ ] **Step 1: Replace the dark block body** with:

```css
  /* Surfaces */
  --background: var(--zinc-950);   /* near #0A0A0B — use #0A0A0B */
  --card: #141416;
  --popover: #1A1A1D;
  --muted: #1F1F22;

  /* Text */
  --foreground: #EDEDEF;
  --card-foreground: var(--foreground);
  --popover-foreground: var(--foreground);
  --muted-foreground: #8B8B90;

  /* Brand */
  --primary: var(--oxblood-500);
  --primary-hover: var(--oxblood-400);
  --primary-foreground: #FBEDEE;

  /* Accent */
  --accent: var(--oxblood-900);
  --accent-foreground: var(--oxblood-100);

  /* Links (AA ≥ 4.5:1 on #141416 / #0A0A0B) */
  --text-link: var(--oxblood-300);     /* #DA7B85 */
  --text-link-hover: var(--oxblood-200);

  /* Semantic signals */
  --success: var(--green-300);
  --success-bg: #0E2A1E;
  --success-foreground: var(--green-200);
  --warning: var(--amber-w-300);
  --warning-bg: #3A2C00;
  --warning-foreground: var(--amber-w-100);
  --danger: var(--oxblood-300);
  --danger-bg: #2A1416;
  --danger-foreground: var(--oxblood-100);
  --positive: var(--green-300);       /* #35BE83 */
  --positive-foreground: #06140E;
  --negative: var(--oxblood-300);     /* #DA7B85 — verify AA on --card in Step 3 */
  --destructive: var(--oxblood-300);
  --destructive-foreground: #06140E;

  /* Borders / structural */
  --secondary: #1F1F22;
  --secondary-hover: #27272A;
  --secondary-foreground: #EDEDEF;
  --border: #242427;
  --input: #3A3A3E;
  --ring: var(--oxblood-400);
  --shadow: 0 14px 28px rgb(0 0 0 / 0.45);

  /* Chart palette */
  --chart-1: var(--oxblood-300);
  --chart-2: var(--green-300);
  --chart-3: var(--gradient-hero-to);
  --chart-4: var(--gradient-hero-from);
  --chart-5: var(--zinc-400);
  --chart-spend: var(--oxblood-300);
  --chart-credit: var(--green-300);
  --chart-payment: var(--zinc-400);
  --chart-business: var(--chart-steel);
  --chart-line-1: var(--chart-spend);
  --chart-line-2: var(--chart-credit);
  --chart-line-3: var(--chart-business);
  --chart-line-4: var(--chart-4);
  --chart-line-5: var(--amber-w-300);
  --chart-line-6: var(--oxblood-200);

  color-scheme: dark;
```

> Note: set `--background: #0A0A0B;` literally (the spec's dark bg is `#0A0A0B`, one notch off `--zinc-950 #09090B`).

- [ ] **Step 2: Verify `--negative`/`--text-link` contrast.** Compute contrast ratio of `#DA7B85` on `#141416` and `#0A0A0B`.

Run: `node -e "const L=h=>{const c=[parseInt(h.slice(1,3),16),parseInt(h.slice(3,5),16),parseInt(h.slice(5,7),16)].map(v=>{v/=255;return v<=.03928?v/12.92:((v+.055)/1.055)**2.4});return .2126*c[0]+.7152*c[1]+.0722*c[2]};const cr=(a,b)=>{const x=L(a)+.05,y=L(b)+.05;return (Math.max(x,y)/Math.min(x,y)).toFixed(2)};console.log('DA7B85 on 141416',cr('#DA7B85','#141416'),'on 0A0A0B',cr('#DA7B85','#0A0A0B'))"`
Expected: both ≥ 4.5. If under 4.5, lighten `--negative`/`--text-link` to `#E29AA2` and re-run until ≥ 4.5; record the final value.

- [ ] **Step 3: Build**

Run: `yarn workspace frontend run build`
Expected: succeeds.

- [ ] **Step 4: Commit**

```bash
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH git add frontend/src/index.css
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH git commit -m "feat(palette): repoint dark semantic tokens to new ramps"
```

---

### Task 4: Delete old ramps; add semantic Tailwind color utilities

**Files:**
- Modify: `frontend/src/index.css` — remove old `--amber-*`/`--plum-*`/`--jade-*`/`--rust-*` ramps and old supporting neutrals (`--bone`, `--sand`, `--taupe`, `--stone`, `--charcoal`, `--ink`, `--cream`, `--champagne`, `--brass`, `--copper`, `--fig`, `--moss`, `--sage`, `--clay`, `--smoke`, `--graphite`); update legacy aliases; extend `@theme inline`

- [ ] **Step 1: Update the legacy alias block** (it currently maps `--accent-warm: var(--primary)` etc.) — repoint any that referenced deleted neutrals to zinc equivalents. Keep alias NAMES (App.css still uses them this phase):

```css
  --bg:            var(--background);
  --bg2:           var(--card);
  --bg3:           var(--muted);
  --fg:            var(--foreground);
  --muted-legacy:  var(--muted-foreground);
  --accent-legacy: var(--primary);
  --accent-soft:   var(--accent);
  --accent-warm:   var(--primary);
  --accent-green:  var(--positive);
```

- [ ] **Step 2: Delete the old ramp + supporting-neutral definitions** from the light `:root` block (the `/* Amber */`…`/* Supporting colors */` blocks). Run a grep to confirm none are still referenced:

Run: `grep -nE "var\(--(amber-[0-9]|plum|jade|rust|bone|sand|taupe|stone|charcoal|ink|cream|champagne|brass|copper|fig|moss|sage|clay|smoke|graphite)" frontend/src/index.css`
Expected: **no output** (every internal reference was repointed in Tasks 2–3). If any line prints, repoint it to the zinc/oxblood/green equivalent before deleting.

- [ ] **Step 3: Add semantic color utilities** inside `@theme inline` (after the `--color-chart-*` lines) so components can write `bg-warning`, `text-positive`, etc.:

```css
  /* Semantic color utilities (so components stop reaching for raw Tailwind hues) */
  --color-warning:            var(--warning);
  --color-warning-bg:         var(--warning-bg);
  --color-warning-foreground: var(--warning-foreground);
  --color-success:            var(--success);
  --color-success-bg:         var(--success-bg);
  --color-success-foreground: var(--success-foreground);
  --color-positive:           var(--positive);
  --color-negative:           var(--negative);
  --color-danger:             var(--danger);
  --color-danger-bg:          var(--danger-bg);
  --color-text-link:          var(--text-link);
```

- [ ] **Step 4: Build**

Run: `yarn workspace frontend run build`
Expected: succeeds; old ramps gone, utilities available.

- [ ] **Step 5: Commit**

```bash
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH git add frontend/src/index.css
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH git commit -m "feat(palette): drop legacy ramps, expose semantic color utilities"
```

---

## Phase 2 — App.css drift cleanup

### Task 5: Remove the 3 off-palette hardcoded sites

**Files:**
- Modify: `frontend/src/App.css:36`, `:789`, `:1279`, `:1284`

- [ ] **Step 1: Replace the blue focus glow** at `App.css:36` (`box-shadow: 0 0 0 3px rgba(119, 167, 255, 0.18);`) with a token-driven oxblood ring:

```css
    box-shadow: 0 0 0 3px color-mix(in oklch, var(--ring) 35%, transparent);
```

- [ ] **Step 2: Replace the blue selection/active fill** at `App.css:789` (`background: rgba(119, 167, 255, 0.16);`) with:

```css
    background: color-mix(in oklch, var(--primary) 14%, transparent);
```

- [ ] **Step 3: Replace the raw Tailwind amber/green insets** at `App.css:1279` and `:1284`:

```css
    /* :1279 was rgba(245, 158, 11, 0.18) — amber */
    box-shadow: inset 0 0 0 1px color-mix(in oklch, var(--warning) 30%, transparent);
    /* :1284 was rgba(34, 197, 94, 0.18) — green */
    box-shadow: inset 0 0 0 1px color-mix(in oklch, var(--positive) 30%, transparent);
```

- [ ] **Step 4: Confirm no off-palette literals remain in App.css**

Run: `grep -nE "rgba\(119, ?167, ?255|rgba\(245, ?158, ?11|rgba\(34, ?197, ?94" frontend/src/App.css`
Expected: no output.

- [ ] **Step 5: Build + commit**

Run: `yarn workspace frontend run build`

```bash
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH git add frontend/src/App.css
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH git commit -m "fix(palette): remove off-palette hardcoded colors in App.css"
```

---

## Phase 3 — Migrate hardcoded Tailwind utilities to semantic tokens

> **Mapping rule (apply consistently).** Built-in Tailwind hue utilities → semantic utility:
>
> | hardcoded | intent | replace with |
> |---|---|---|
> | `bg-amber-50/100` | warning surface | `bg-warning-bg` |
> | `text-amber-700/800/900` | warning text | `text-warning` |
> | `text-amber-200/300` (dark variants) | warning text | `text-warning` (token already mode-aware — drop the `dark:` twin) |
> | `bg-emerald-*` | positive surface | `bg-success-bg` |
> | `text-emerald-*` | positive text | `text-positive` |
> | `bg-red-*` | danger surface | `bg-danger-bg` |
> | `text-red-*` | danger/negative text | `text-danger` (or `text-negative` for money-out figures) |
> | `text-orange-*` | usually warning | `text-warning` (judge per use; if it's a gradient/brand accent, use `text-[var(--gradient-hero-from)]`) |
> | `*-green-*` | positive | `*-positive` / `bg-success-bg` |
> | `bg-brand` / `text-brand-*` | brand | leave as-is (already token-driven via `--color-brand`) |
>
> Because tokens are already mode-aware, **delete paired `dark:` color twins** for these (e.g. `text-amber-800 dark:text-amber-200` → `text-warning`). Keep non-color `dark:` utilities.
>
> **Expanded during execution** (inventory was larger than estimated — see counts in session):
> | hardcoded | intent | replace with |
> |---|---|---|
> | `rose-*` | danger / money-loss | `bg-danger-bg`/`text-danger` (or `text-negative` for a negative $ figure) |
> | `blue-*`/`sky-*` info or in-progress | info | `bg-info-bg`/`text-info`/`bg-info` (new `info` token = steel-blue) |
> | `focus:border-blue-500` (input focus) | focus ring | `focus:border-ring` |
> | `violet-*` | info/accent | `text-info`/`bg-info-bg` (unless categorical — see below) |
> | `gray/slate/zinc-900/800` text | body text | `text-foreground` |
> | `gray/slate/zinc-700/600/500/400/300` text | secondary text | `text-muted-foreground` |
> | `gray/slate/zinc-50/100/200` bg | subtle surface | `bg-muted` |
> | `gray/slate/zinc-100/200/300` border | border | `border` |
> | `bg-white`/`text-white`/`bg-black`/`text-black` | leave as-is (intentional, in-context) |
>
> **Categorical maps** (e.g. `api.ts` `CALENDAR_EVENT_*`, status maps): assign per category, keep JIT-literal class strings —
> income→success, expense→danger, transfer→info, settlement→warning, debt_payment→danger, savings→success;
> status: Running/in-progress→info, Success/ok→positive, Failure/error→danger, Skipped/Never→muted.
> `info` token added in commit `227babf0` (light `#1B6FA8`, dark steel `#5EA8E0`, AA verified).

### Task 6: Sweep the 28 files, one commit per logical group

**Files (from `grep -rlE "(text|bg|border|ring|from|to|via|fill|stroke)-(amber|emerald|red|orange|green)-[0-9]+" frontend/src --include=*.tsx`):** regenerate this list at execution time; known hits include `components/RefundBadge.tsx`, `components/dashboard/BudgetStatusCard.tsx`, `components/dashboard/NetWorthTile.tsx`, `components/accounts/UtilizationBadge.tsx`, `components/import/ImportHistoryTable.tsx`, `components/import/ImportProgressBadge.tsx`, `components/notifications/NotificationPanel.tsx`, `pages/GoalsPage.tsx`, and ~20 more.

- [ ] **Step 1: Regenerate the authoritative file list**

Run: `grep -rlE "(text|bg|border|ring|from|to|via|fill|stroke)-(amber|emerald|red|orange|green)-[0-9]+" frontend/src --include=*.tsx | sort`
Expected: ~28 paths. This is the worklist.

- [ ] **Step 2: For each file, apply the mapping rule.** Example — `components/accounts/UtilizationBadge.tsx:24` (`bg-amber-100 text-amber-900` for a near-limit warning):

Before:
```tsx
className="... bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200 ..."
```
After:
```tsx
className="... bg-warning-bg text-warning ..."
```

Apply the same intent-mapping to every match in the file. Where a usage is a true data color (e.g. a chart series), route it through a `--chart-*` token instead (see Task 7), not a semantic one.

- [ ] **Step 3: After each file (or small group), run that file's test if one exists.** Example:

Run: `yarn workspace frontend run test UtilizationBadge`
Expected: PASS. Note: `UtilizationBadge.test.tsx` currently asserts `bg-amber-100` (line 37, 61) — update those assertions to `bg-warning-bg` as part of this task (the test encodes the old palette).

- [ ] **Step 4: Repeat for all files. Verify the sweep is complete:**

Run: `grep -rnE "(text|bg|border|ring|from|to|via|fill|stroke)-(amber|emerald|red|orange|green)-[0-9]+" frontend/src --include=*.tsx`
Expected: **no output** (or only documented intentional exceptions, e.g. a multi-color legend — none expected).

- [ ] **Step 5: Full frontend test + build**

Run: `yarn workspace frontend run test && yarn workspace frontend run build`
Expected: all pass.

- [ ] **Step 6: Commit** (group sensibly, e.g. by directory)

```bash
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH git add frontend/src
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH git commit -m "refactor(palette): migrate hardcoded Tailwind color utilities to semantic tokens"
```

---

### Task 7: Migrate the extended chart token block + chart components

**Files:**
- Modify: `frontend/src/index.css` — the `/* Extended chart tokens */` block (`--chart-income`, `--chart-category`, `--chart-business-alt`, `--chart-savings`, `--chart-uncategorized`, `--chart-scenario*`, `--chart-reference`, `--chart-portfolio`, `--chart-danger-line`, `--chart-link-stroke`) which currently hardcodes raw hexes (`#10b981`, `#3b82f6`, …)

- [ ] **Step 1: Repoint the extended chart tokens** onto the categorical set (spec: oxblood / orange / pink / green / steel-blue / grey / oxblood-300 / amber). Replace the block:

```css
  --chart-income:           var(--green-600);
  --chart-income-stroke:    var(--green-700);
  --chart-category:         var(--chart-steel);
  --chart-business-alt:     var(--gradient-hero-to);   /* pink */
  --chart-savings:          var(--gradient-hero-from); /* orange */
  --chart-uncategorized:    var(--zinc-400);
  --chart-scenario:         var(--chart-steel);
  --chart-scenario-pos:     var(--green-600);
  --chart-scenario-neg:     var(--oxblood-500);
  --chart-reference:        var(--zinc-400);
  --chart-portfolio:        var(--chart-steel);
  --chart-danger-line:      var(--oxblood-500);
  --chart-link-stroke:      var(--zinc-700);
```

Provide dark overrides in the dark block where a value must shift for contrast (income → `--green-300`, danger → `--oxblood-300`, link-stroke → `--zinc-300`).

- [ ] **Step 2: Find any chart component hardcoding these hexes directly** rather than reading the token:

Run: `grep -rnE "#(10b981|059669|3b82f6|8b5cf6|06b6d4|9ca3af|6366f1|16a34a|dc2626|94a3b8|2563eb|ef4444|0f172a)" frontend/src --include=*.tsx`
Expected: list of any inline hexes; replace each with the matching `var(--chart-*)` token.

- [ ] **Step 3: Build + test**

Run: `yarn workspace frontend run build && yarn workspace frontend run test`
Expected: pass.

- [ ] **Step 4: Commit**

```bash
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH git add frontend/src
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH git commit -m "refactor(palette): route extended chart tokens through categorical set"
```

---

## Phase 4 — Live palette page under Settings

### Task 8: Build the PaletteSection (TDD)

**Files:**
- Create: `frontend/src/pages/settings/sections/PaletteSection.tsx`
- Create: `frontend/src/pages/settings/sections/PaletteSection.test.tsx`
- Reference: `frontend/src/pages/settings/sections/DisplaySection.tsx` (existing sibling — match its structure/heading conventions), `frontend/src/contexts/theme.ts` (`useTheme`)

- [ ] **Step 1: Write the failing test**

```tsx
import { render, screen } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import { PaletteSection } from './PaletteSection'

describe('PaletteSection', () => {
  it('renders the palette swatch groups', () => {
    render(<PaletteSection />)
    expect(screen.getByRole('heading', { name: /palette/i })).toBeInTheDocument()
    // groups
    expect(screen.getByText(/greyscale/i)).toBeInTheDocument()
    expect(screen.getByText(/oxblood/i)).toBeInTheDocument()
    expect(screen.getByText(/gradient/i)).toBeInTheDocument()
  })

  it('reads live token values via getComputedStyle (renders a hex)', () => {
    render(<PaletteSection />)
    // every swatch shows the resolved value; at least one hex/color string present
    expect(screen.getAllByTestId('swatch-value').length).toBeGreaterThan(0)
  })
})
```

- [ ] **Step 2: Run it — expect fail**

Run: `yarn workspace frontend run test PaletteSection`
Expected: FAIL — `PaletteSection` not found.

- [ ] **Step 3: Implement `PaletteSection.tsx`** — read tokens at runtime so it never drifts:

```tsx
import { useEffect, useState } from 'react'

type Swatch = { label: string; token: string }
type Group = { name: string; swatches: Swatch[] }

const GROUPS: Group[] = [
  { name: 'Greyscale', swatches: [50,100,200,300,400,500,600,700,800,900,950]
      .map(n => ({ label: `zinc-${n}`, token: `--zinc-${n}` })) },
  { name: 'Oxblood', swatches: [50,100,200,300,400,500,600,700,800,900]
      .map(n => ({ label: `oxblood-${n}`, token: `--oxblood-${n}` })) },
  { name: 'Green', swatches: [100,200,300,500,600,700]
      .map(n => ({ label: `green-${n}`, token: `--green-${n}` })) },
  { name: 'Semantic', swatches: [
      { label: 'background', token: '--background' },
      { label: 'card', token: '--card' },
      { label: 'foreground', token: '--foreground' },
      { label: 'primary', token: '--primary' },
      { label: 'positive', token: '--positive' },
      { label: 'negative', token: '--negative' },
      { label: 'warning', token: '--warning' },
      { label: 'danger', token: '--danger' },
      { label: 'text-link', token: '--text-link' },
      { label: 'border', token: '--border' },
    ] },
  { name: 'Gradient', swatches: [{ label: 'gradient-hero', token: '--gradient-hero' }] },
]

function useTokenValues(tokens: string[]): Record<string, string> {
  const [vals, setVals] = useState<Record<string, string>>({})
  useEffect(() => {
    const cs = getComputedStyle(document.documentElement)
    const next: Record<string, string> = {}
    for (const t of tokens) next[t] = cs.getPropertyValue(t).trim()
    setVals(next)
    // re-read when theme attribute flips
    const obs = new MutationObserver(() => {
      const cs2 = getComputedStyle(document.documentElement)
      const n2: Record<string, string> = {}
      for (const t of tokens) n2[t] = cs2.getPropertyValue(t).trim()
      setVals(n2)
    })
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    return () => obs.disconnect()
  }, [tokens.join(',')]) // eslint-disable-line react-hooks/exhaustive-deps
  return vals
}

export function PaletteSection() {
  const allTokens = GROUPS.flatMap(g => g.swatches.map(s => s.token))
  const values = useTokenValues(allTokens)
  return (
    <section className="space-y-6">
      <h2 className="text-lg font-semibold text-foreground">Palette</h2>
      <p className="text-sm text-muted-foreground">
        Live design tokens, read from CSS at runtime. Reflects the active theme.
      </p>
      {GROUPS.map(group => (
        <div key={group.name} className="space-y-2">
          <h3 className="text-sm font-medium text-muted-foreground">{group.name}</h3>
          <div className="flex flex-wrap gap-2">
            {group.swatches.map(s => {
              const v = values[s.token] ?? ''
              const isGradient = s.token === '--gradient-hero'
              return (
                <div key={s.token} className="flex flex-col items-center gap-1">
                  <div
                    className="h-12 w-16 rounded-md border border-border"
                    style={isGradient ? { backgroundImage: v } : { backgroundColor: `var(${s.token})` }}
                  />
                  <span className="text-[10px] text-muted-foreground">{s.label}</span>
                  <span data-testid="swatch-value" className="font-mono text-[9px] text-muted-foreground">{v}</span>
                </div>
              )
            })}
          </div>
        </div>
      ))}
    </section>
  )
}
```

- [ ] **Step 4: Run test — expect pass**

Run: `yarn workspace frontend run test PaletteSection`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH git add frontend/src/pages/settings/sections/PaletteSection.tsx frontend/src/pages/settings/sections/PaletteSection.test.tsx
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH git commit -m "feat(settings): add live palette reference section"
```

---

### Task 9: Wire PaletteSection into Settings navigation

**Files:**
- Modify: `frontend/src/App.tsx` (settings `<Route>` block near `:171`, imports near `:47`)
- Modify: `frontend/src/pages/settings/useActiveSettingsTopTab.ts` (if a tab id/match is required — mirror the `labels` pattern at `:11`, `:32`, `:50`)
- Reference: `frontend/src/pages/settings/SettingsTabLayout.tsx` for how sections appear in nav

- [ ] **Step 1: Read the existing wiring** to copy the exact pattern.

Run: `sed -n '160,185p' frontend/src/App.tsx`
Expected: see how `DisplaySection`/other sections are mounted under `/settings`.

- [ ] **Step 2: Add the import and route** following the established pattern, e.g.:

```tsx
import { PaletteSection } from './pages/settings/sections/PaletteSection'
// …inside the <Route path="settings" …> children, beside DisplaySection:
<Route path="palette" element={<PaletteSection />} />
```

If `DisplaySection` is rendered inside a parent "Appearance" section rather than its own route, nest `PaletteSection` there instead (match what Step 1 reveals — do NOT invent a route shape).

- [ ] **Step 3: Add the nav entry / tab id** if `SettingsTabLayout` enumerates sections explicitly (add a `palette` entry mirroring siblings; add to `SettingsTopTab` union + `useMatch('/settings/palette')` in `useActiveSettingsTopTab.ts` if that's the pattern).

- [ ] **Step 4: Update the settings routing integration test**

Run: `yarn workspace frontend run test settings-routing`
Expected: PASS. If it enumerates expected sections, add `palette` to the expectation.

- [ ] **Step 5: Build + commit**

Run: `yarn workspace frontend run build`

```bash
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH git add frontend/src
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH git commit -m "feat(settings): mount palette section in navigation"
```

---

## Phase 5 — Guards & verification

### Task 10: Add a drift-guard test

**Files:**
- Create: `frontend/src/styles.guard.test.ts` (colocated unit test; vitest)

- [ ] **Step 1: Write the guard test** (reads the CSS files as text and asserts no banned literals):

```ts
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'

const root = join(__dirname)
const appCss = readFileSync(join(root, 'App.css'), 'utf8')
const indexCss = readFileSync(join(root, 'index.css'), 'utf8')

describe('palette drift guard', () => {
  it('App.css has no off-palette hardcoded colors', () => {
    expect(appCss).not.toMatch(/rgba\(119,\s*167,\s*255/)   // old blue glow
    expect(appCss).not.toMatch(/rgba\(245,\s*158,\s*11/)    // raw tailwind amber
    expect(appCss).not.toMatch(/rgba\(34,\s*197,\s*94/)     // raw tailwind green
  })

  it('index.css no longer defines retired ramps', () => {
    expect(indexCss).not.toMatch(/--plum-\d/)
    expect(indexCss).not.toMatch(/--jade-\d/)
    expect(indexCss).not.toMatch(/--rust-\d/)
  })
})
```

- [ ] **Step 2: Run it**

Run: `yarn workspace frontend run test styles.guard`
Expected: PASS (Phases 1–2 already removed these).

- [ ] **Step 3: Commit**

```bash
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH git add frontend/src/styles.guard.test.ts
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH git commit -m "test(palette): guard against off-palette literal regressions"
```

---

### Task 11: Full verification + visual smoke

- [ ] **Step 1: Run the whole frontend suite + build**

Run: `yarn workspace frontend run test && yarn workspace frontend run build`
Expected: all green.

- [ ] **Step 2: Visual smoke (manual, both modes).** Install deps if needed (`yarn` at repo root), `yarn dev`, open `:5173`. Confirm in **dark** then **light**: dashboard renders greyscale surfaces, oxblood primary buttons, gradient Net hero tile, green income, oxblood spend; Settings → Palette page shows swatches and updates when you toggle the theme. No stray amber/blue.

- [ ] **Step 3: Full CI parity (optional but recommended before merge)**

Run: `yarn ci`
Expected: typecheck + tests + both builds pass.

---

## Self-Review notes (addressed)

- **Spec coverage:** token ramps (T1–4), both modes (T2/T3), gradient hero token (T1), drift cleanup (T5), chart categorical set (T2/T3/T7), live palette page under Settings reading getComputedStyle (T8–9), AA verification for `--negative`/links (T3 Step 2). Hardcoded-utility sweep (full remap, per user decision) = Phase 3.
- **New surfaced item folded in:** the palette had no warning/caution hue; added an `amber-w-*` warning ramp + `--warning` mapping (T1, T2, T3) and semantic color utilities in `@theme inline` (T4) so the amber-utility sweep has a real target.
- **Type/name consistency:** semantic utility class names (`bg-warning-bg`, `text-warning`, `text-positive`, `bg-success-bg`, `text-danger`, `text-negative`) are defined in T4 and used in T6. `--gradient-hero{,-from,-to}`, `--chart-steel`, `--amber-w-*` defined in T1 and referenced thereafter.
