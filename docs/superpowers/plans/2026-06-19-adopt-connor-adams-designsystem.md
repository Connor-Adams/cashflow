# Adopt @connor-adams/designsystem & Retire @cashflow/ui — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the Cashflow frontend off the internal `@cashflow/ui` workspace package and onto the external **`@connor-adams/designsystem`** (GitHub Packages), then delete `@cashflow/ui` from the monorepo — with the app building, type-checking, and tests green at every step.

**Architecture:** App-side migration. The frontend consumes `@connor-adams/designsystem` (components) + `@connor-adams/tokens` (raw CSS-variable token layer) from GitHub Packages. The app **bends to the DS's API** — where a call site used an `@cashflow/ui` symbol the DS doesn't provide, we adapt the call site to the DS's native API or add a **fresh, app-local** helper (never copied from `@cashflow/ui`). The Tailwind `@theme`/custom-`@utility` layer that `@cashflow/ui` currently owns is re-established **fresh in the frontend** from `@connor-adams/tokens`. `@cashflow/ui` is deleted only once zero files import it.

**Tech Stack:** Yarn 4.17 workspaces, Vite + React 19, Tailwind v4, vitest + @testing-library/react, TypeScript. DS published to GitHub Packages (`npm.pkg.github.com`, scope `@connor-adams`) — consumed via committed `.npmrc` + `.yarnrc.yml` + `NODE_AUTH_TOKEN`.

---

## ⚠️ Critical risks & open decisions (READ FIRST — review before executing)

These are surfaced for the plan reviewer. They are real and gate success.

1. **Token/theme layer is a hidden showstopper.** `@cashflow/ui` does NOT just ship components — it owns the design tokens + the Tailwind v4 `@theme inline` mapping + custom `@utility` definitions (`bg-button-*`, `border-*`). The frontend's `index.css` does `@import "@cashflow/ui/theme.css"` and **all 117 pages** use Tailwind color utilities (`bg-card`, `text-muted-foreground`, `border-border`, `bg-button-primary`) that only exist because of that layer. **Deleting `@cashflow/ui` breaks every page's colors, not just components.** `@connor-adams/tokens` ships *raw* CSS variables only — not the Tailwind mapping. **Task 1 re-establishes that layer fresh in the frontend** and is the true critical path. If Task 1's token names don't cover what the pages use, the build "succeeds" but renders unstyled — Task 1 includes a guard test.

2. **The DS is prototype-grade.** `@connor-adams/designsystem` components are authored as inline `style={}` + JS-state hover (`useState`/`onMouseEnter`), have **zero tests**, and differ in API from `@cashflow/ui`. Adopting them will produce **visual and interaction differences** (no CSS `:hover`/`:focus-visible`, inline styles that `className` can't override). This plan does not fix that — it adopts the DS as-is per the "just use the DS" decision. Expect a visual-regression review pass (Task 9).

3. **6 gap symbols + API deltas.** The DS lacks `SkeletonRow` (23 files), `EmptyTableRow` (21), `useConfirm` (15), `Grid` (15), `NativeSelectOption` (13), `TabPanel` (~9); and `Tabs`/`Dialog`/`NativeSelect` have different APIs. Tasks 4–5 provide fresh app-local helpers (`frontend/src/lib/ds-extras/`) + an API-delta adaptation table. None copy `@cashflow/ui`.

4. **GitHub Packages auth.** Couldn't verify the package is actually published/installable (local `gh` token lacks `read:packages`). Task 2 Step 1 is a hard gate: if `yarn add @connor-adams/designsystem` fails, STOP and resolve publishing/auth before continuing.

---

## Global Constraints

- Yarn 4.17 workspaces; run everything from repo root `/Users/connoradams/Developer/cashflow`. Never create nested `node_modules`.
- **Do NOT copy, import, or reference any code from `@cashflow/ui` (`packages/ui`).** Adapt to the DS or author fresh. (`packages/ui` is being deleted.)
- Commit author is **Connor only** — never add a `Co-Authored-By` trailer.
- Commits run under husky; prefix commits with `PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH` if hooks fail to find binaries.
- Single frontend test: `yarn workspace frontend run test <NameFragment>`; by name: `… run test -- -t '<regex>'`. Lint: `yarn workspace frontend run lint`.
- Color = tokens only (no hex literals) in any new/edited code; use the Tailwind token utilities re-established in Task 1.
- TDD: each behavioral change gets a test that fails before and passes after. Migration/repoint tasks are guarded by characterization tests on the affected pages.
- The DS theme switch is `data-theme="dark"` on the root element (NOT a `.dark` class) — match it.

---

## File Structure

**Created:**
- `.npmrc` (repo root) — GitHub Packages registry + auth-token reference for `@connor-adams`.
- `.yarnrc.yml` additions — `npmScopes` / `npmRegistries` for Yarn 4 GitHub Packages auth.
- `frontend/src/styles/theme.css` — fresh Tailwind `@theme inline` mapping + custom `@utility` defs, sourced from `@connor-adams/tokens` var names. (Replaces the `@cashflow/ui/theme.css` import.)
- `frontend/src/lib/ds-extras/` — fresh app-local helpers the DS doesn't provide: `empty-table-row.tsx`, `skeleton-row.tsx`, `grid.tsx`, `use-confirm.tsx`, `index.ts`.
- `frontend/src/lib/ds-extras/*.test.tsx` — unit tests for each helper.
- `frontend/test/token-layer.test.ts` — guard asserting the re-established token utilities resolve (catches the silent-unstyled failure).

**Modified:**
- `frontend/src/index.css` — drop `@import "@cashflow/ui/theme.css"`, add `@import "@connor-adams/tokens/styles.css"` + `@import "./styles/theme.css"`.
- `frontend/package.json` — remove `@cashflow/ui`; add `@connor-adams/designsystem` + `@connor-adams/tokens`.
- `frontend/src/main.tsx` (or app root) — import the DS stylesheet once; ensure `data-theme` is set.
- `.github/workflows/*.yml` — `packages: read` + `setup-node` registry config + `NODE_AUTH_TOKEN`.
- ~201 files under `frontend/src/**` — repoint imports `@cashflow/ui` → `@connor-adams/designsystem` (+ the helpers), adapting to API deltas (Tasks 6–8).
- `frontend/src/components/ui/stat-card.tsx`, `sparkline.tsx`, `letter-avatar.tsx` — decide DS-native vs keep-local (Task 7).

**Deleted (final task):**
- `packages/ui/` (the `@cashflow/ui` workspace) + its workspace entry.

---

### Task 1: Re-establish the token + Tailwind theme/utility layer (fresh, from @connor-adams/tokens)

This is the critical path. Today the app's Tailwind colors come from `@cashflow/ui/theme.css`. We rebuild that mapping in the frontend, sourced from `@connor-adams/tokens` raw vars, so deleting `@cashflow/ui` later does not break page colors.

**Files:**
- Create: `frontend/src/styles/theme.css`
- Create: `frontend/test/token-layer.test.ts`
- Modify: `frontend/src/index.css`

**Interfaces:**
- Consumes: raw CSS variables from `@connor-adams/tokens` (`--background --card --foreground --muted --muted-foreground --primary --primary-foreground --border --input --ring --destructive --danger --warning --success --positive --negative --accent --accent-foreground --text-link --radius* --space* --text-* --weight-*`, etc. — full list from `packages/tokens/src/{colors,semantic,typography,spacing}.css`).
- Produces: Tailwind v4 utilities the pages already use (`bg-card`, `text-muted-foreground`, `border-border`, `bg-background`, `text-foreground`, `bg-muted`, `text-danger`, `rounded-lg`, …).

- [ ] **Step 1: Inventory the Tailwind token utilities the app actually uses**

Run from repo root (read-only; produces the required mapping set):
```bash
cd frontend/src
grep -rhoE 'className="[^"]*"' --include=*.tsx . \
  | grep -oE '\b(bg|text|border|ring|from|to|fill|stroke)-[a-z][a-z0-9-]+' \
  | sort -u > /tmp/used-utilities.txt
wc -l /tmp/used-utilities.txt
```
Cross-reference each color/token utility against `@connor-adams/tokens` var names (the agent-confirmed list: semantic.css has `--card --foreground --muted-foreground --border --input --ring --primary --destructive --danger(-bg) --warning(-bg) --success(-bg) --positive --negative(-bg) --accent(-foreground) --text-link` …). Note any utility whose backing token is missing — those go in Step 3's "token gaps."

- [ ] **Step 2: Write the guard test (fails first)**

Create `frontend/test/token-layer.test.ts`. It asserts that the compiled app CSS defines the critical token utilities (catches the "builds but unstyled" failure):
```ts
import { describe, expect, it } from 'vitest'
import { execSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'

// Build the frontend CSS once and assert token utilities + token vars survive.
describe('token layer', () => {
  it('compiled CSS defines the semantic token utilities the pages use', () => {
    execSync('yarn workspace frontend run build', { stdio: 'inherit' })
    const css = readFileSync(findBuiltCss(), 'utf8')
    for (const needle of ['--primary', '--card', '--muted-foreground', '--border', '.bg-card', '.text-muted-foreground', '.border-border']) {
      expect(css, `missing ${needle}`).toContain(needle)
    }
  })
})

function findBuiltCss(): string {
  // dist asset name is hashed; pick the largest .css under frontend/dist/assets
  const dir = 'frontend/dist/assets'
  if (!existsSync(dir)) throw new Error('no built assets — did build run?')
  const files = execSync(`ls -S ${dir}/*.css`).toString().trim().split('\n')
  return files[0]
}
```
Run: `yarn workspace frontend run test token-layer` → Expected: FAIL (theme not yet rewired; `--primary`/utilities absent or build references missing `@cashflow/ui/theme.css`).

- [ ] **Step 3: Author `frontend/src/styles/theme.css` fresh**

Write the Tailwind v4 `@theme inline` block mapping `@connor-adams/tokens` vars → Tailwind utility names, plus the custom `@utility` defs the pages need (`border-*` for `border-border` etc.). Author from the var inventory — do NOT copy `@cashflow/ui`'s file. Skeleton (fill every mapping from Step 1's inventory):
```css
/* App-owned Tailwind theme mapping. Sourced from @connor-adams/tokens raw vars.
   Replaces the former @cashflow/ui/theme.css import. */
@theme inline {
  --color-background: var(--background);
  --color-foreground: var(--foreground);
  --color-card: var(--card);
  --color-card-foreground: var(--card-foreground);
  --color-muted: var(--muted);
  --color-muted-foreground: var(--muted-foreground);
  --color-primary: var(--primary);
  --color-primary-foreground: var(--primary-foreground);
  --color-accent: var(--accent);
  --color-accent-foreground: var(--accent-foreground);
  --color-border: var(--border);
  --color-input: var(--input);
  --color-ring: var(--ring);
  --color-danger: var(--danger);
  --color-warning: var(--warning);
  --color-success: var(--success);
  --color-positive: var(--positive);
  --color-negative: var(--negative);
  --radius-sm: calc(var(--radius) - 4px);
  --radius-md: calc(var(--radius) - 2px);
  --radius-lg: var(--radius);
  /* …every other utility surfaced by Step 1's inventory… */
}

/* border-{name} → --color-border-{name}; pages use border-border heavily. */
@utility border-* {
  border-color: --value(--color-border-*);
}
```
> Any token a page uses but `@connor-adams/tokens` does not define (e.g. legacy `--accent-warm`/`--accent-green`/`--accent-positive` used by `sparkline.tsx`/`alert`): add a fresh aliasing line in this file pointing at the nearest DS token (`--accent-warm: var(--warning)` etc.), and log it in a `/* token aliases — reconcile */` comment block. Do not reintroduce `@cashflow/ui`.

- [ ] **Step 4: Rewire `frontend/src/index.css`**

Replace the `@cashflow/ui` token import. Change:
```css
@import "tailwindcss";
@import "@cashflow/ui/theme.css";
@source "../../packages/ui/src/components/**/*.{ts,tsx}";
```
to:
```css
@import "tailwindcss";
@import "@connor-adams/tokens/styles.css";
@import "./styles/theme.css";
```
(Drop the `@source` line pointing at `packages/ui` — that package is leaving. Keep the `@custom-variant dark` line if present.)

- [ ] **Step 5: Run the guard test, verify it passes**

Run: `yarn workspace frontend run test token-layer` → Expected: PASS. Spot-check by running `yarn dev` and confirming the dashboard still has color (manual; note in commit).

- [ ] **Step 6: Commit**
```bash
git add frontend/src/styles/theme.css frontend/src/index.css frontend/test/token-layer.test.ts
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH git commit -m "feat(ui): own the Tailwind theme/utility layer from @connor-adams/tokens"
```

> NOTE: This task still leaves `@cashflow/ui` imported by component call sites — that's fine; only the token layer moved. The app still builds because `@cashflow/ui`'s *components* are untouched until Task 6.

---

### Task 2: Wire the @connor-adams/designsystem dependency (GitHub Packages)

**Files:**
- Create: `.npmrc`
- Modify: `.yarnrc.yml`, `frontend/package.json`

**Interfaces:**
- Produces: resolvable `@connor-adams/designsystem` + `@connor-adams/tokens` imports for all later tasks.

- [ ] **Step 1: HARD GATE — confirm the package installs**

Create `.npmrc` (repo root, committed):
```
@connor-adams:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}
```
Add to `.yarnrc.yml` (Yarn 4 reads its own auth config, not `.npmrc`, for installs):
```yaml
npmScopes:
  connor-adams:
    npmRegistryServer: "https://npm.pkg.github.com"
    npmAuthToken: "${NODE_AUTH_TOKEN}"
```
Export a token with `read:packages` and install:
```bash
export NODE_AUTH_TOKEN=<a GitHub PAT with read:packages>
corepack yarn workspace frontend add @connor-adams/designsystem @connor-adams/tokens
```
Expected: resolves + adds to `frontend/package.json`. **If this 404s/401s, STOP** — the package isn't published or the token lacks scope. Resolve before any further task (this is risk #4).

- [ ] **Step 2: Import the DS stylesheet at the app root**

In `frontend/src/main.tsx` (or wherever global CSS is imported), add once, after `index.css`:
```ts
import '@connor-adams/designsystem/styles.css'
```
Confirm `data-theme` is set on `<html>`/`<body>` by the existing theme logic (the DS dark block is `:root[data-theme="dark"]`). If the app currently toggles a `.dark` class only, add `data-theme` alongside it in the theme switcher (note the file).

- [ ] **Step 3: Verify install + build still green**

Run: `corepack yarn install && yarn workspace frontend run build` → Expected: builds (app still imports `@cashflow/ui` for components — both packages present is fine).

- [ ] **Step 4: Commit**
```bash
git add .npmrc .yarnrc.yml frontend/package.json frontend/src/main.tsx yarn.lock
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH git commit -m "build(ui): add @connor-adams/designsystem + tokens from GitHub Packages"
```

---

### Task 3: CI — authenticate GitHub Packages

**Files:**
- Modify: the frontend/CI workflow(s) under `.github/workflows/` that run `yarn install`.

- [ ] **Step 1: Add packages read + registry auth to each install job**

In every workflow job that installs deps, add:
```yaml
permissions:
  contents: read
  packages: read
steps:
  - uses: actions/checkout@v4
  - uses: actions/setup-node@v4
    with:
      node-version: 22
      registry-url: https://npm.pkg.github.com
      scope: '@connor-adams'
  - run: corepack enable && corepack yarn install --immutable
    env:
      NODE_AUTH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

- [ ] **Step 2: Commit** (CI verifies itself on push)
```bash
git add .github/workflows
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH git commit -m "ci: authenticate GitHub Packages for @connor-adams scope"
```

---

### Task 4: Build the API-delta map (read-only reference doc)

Produces the single source of truth Tasks 6–8 follow. No code change.

**Files:**
- Create: `docs/superpowers/specs/2026-06-19-ds-api-delta.md`

- [ ] **Step 1: Write the delta table**

Document, per `@cashflow/ui` symbol, the DS equivalent and the required call-site change. Seed it with these confirmed deltas:

| `@cashflow/ui` symbol | Files | DS equivalent | Call-site change |
|---|---|---|---|
| `Button` (variant/size) | 139 | `Button` (variant `default/primary/secondary/outline/ghost/destructive/danger/link`, size `sm/default/lg/icon`) | 1:1 import swap; verify `asChild` users (DS Button has no `asChild`/Slot) → unwrap. |
| `Card`+sub | 102 | `Card/CardHeader/CardTitle/CardDescription/CardContent` | 1:1. |
| `Badge` | 49 | `Badge` (`variant` via `BadgeVariant`) | 1:1; `badgeVariants` not exported → inline the class if any consumer used it (grep: ~0). |
| `Input` | 41 | `Input` (`invalid?` not `aria-invalid` class) | 1:1; map any `aria-invalid` usage to `invalid`. |
| `EmptyState` | 40 | `EmptyState` (`title/description/actions`) | 1:1. |
| `Alert` | 34 | `Alert` (`variant/title/action`) | 1:1. |
| `NativeSelect` | 31 | `NativeSelect` (`options?: (string|{value,label})[]` or children `<option>`) | swap; keep children `<option>` form. |
| `Label` | 30 | `Label` | 1:1. |
| `SkeletonRow` | 23 | — (gap) | use `ds-extras/SkeletonRow` (Task 5). |
| `EmptyTableRow` | 21 | — (gap) | use `ds-extras/EmptyTableRow` (Task 5). |
| `useConfirm` | 15 | — (gap) | use `ds-extras/useConfirm` over DS `Dialog` (Task 5). |
| `Grid` | 15 | — (gap) | use `ds-extras/Grid` (Task 5). |
| `NativeSelectOption` | 13 | — (gap) | replace with plain `<option>` (DS `NativeSelect` renders children/options). |
| `Skeleton`/`SkeletonText` | 10 | `Skeleton`(`w/h`)/`SkeletonText`(`lines`) | adjust props (`className h-x w-y` → `w`/`h`). |
| `Textarea` | 9 | `Textarea` | 1:1. |
| `Tabs`+`TabPanel` | 9 | `Tabs` (`items/value/onValueChange`); no `TabPanel` | render body conditionally on active value (Task 5 pattern). |
| `Table`+sub | ~6 | `Table`(`maxHeight`)/`TableHeader/Body/Row(selected)/Head/Cell` | 1:1 (note: DS `TableRow` JS-hover). |
| `Dialog`+sub | ~3 | `Dialog` (`open/onClose/title/description/footer/size`) | rewrite compound children → DS prop-based Dialog. |

- [ ] **Step 2: Commit**
```bash
git add docs/superpowers/specs/2026-06-19-ds-api-delta.md
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH git commit -m "docs(ui): @cashflow/ui → @connor-adams/designsystem API delta map"
```

---

### Task 5: Fresh app-local gap helpers (TDD)

Build the symbols the DS lacks, fresh, over DS primitives. One sub-task per helper; each is test-first. (Showing `EmptyTableRow`; `SkeletonRow`, `Grid`, `useConfirm` follow the same shape — full code below.)

**Files:**
- Create: `frontend/src/lib/ds-extras/{empty-table-row,skeleton-row,grid,use-confirm,index}.tsx` + colocated `*.test.tsx`.

- [ ] **Step 5a: `EmptyTableRow` (test fails → implement → passes)**

Test `empty-table-row.test.tsx`:
```tsx
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { EmptyTableRow } from './empty-table-row'

describe('EmptyTableRow', () => {
  it('renders a spanning row with title + description', () => {
    render(<table><tbody><EmptyTableRow colSpan={3} title="None yet" description="Add one." /></tbody></table>)
    expect(screen.getByText('None yet')).toBeInTheDocument()
    expect(screen.getByRole('cell')).toHaveAttribute('colspan', '3')
  })
})
```
Implementation `empty-table-row.tsx` (over DS `EmptyState`):
```tsx
import * as React from 'react'
import { EmptyState } from '@connor-adams/designsystem'

export function EmptyTableRow({ colSpan, title, description }: {
  colSpan: number; title: React.ReactNode; description?: React.ReactNode
}) {
  return (
    <tr><td colSpan={colSpan} className="whitespace-normal align-top px-4 py-5">
      <EmptyState title={title} description={description} />
    </td></tr>
  )
}
```

- [ ] **Step 5b: `SkeletonRow`** — `<tr>` of `cols` `<td>`s each wrapping DS `<Skeleton w="100%" h={16} />`. Test asserts `cols` cells render.

- [ ] **Step 5c: `Grid`** — fresh responsive grid; no DS dependency:
```tsx
import * as React from 'react'
export function Grid({ minItemWidth = 180, gap = 'md', fill = false, className, style, ...props }: React.ComponentProps<'div'> & { minItemWidth?: number; gap?: 'sm'|'md'|'lg'; fill?: boolean }) {
  const GAP = { sm: 'gap-2', md: 'gap-3', lg: 'gap-4' } as const
  const cols = `repeat(${fill ? 'auto-fill' : 'auto-fit'}, minmax(min(100%, ${minItemWidth}px), 1fr))`
  return <div className={`grid ${GAP[gap]} ${className ?? ''}`} style={{ ...style, gridTemplateColumns: cols }} {...props} />
}
```
Test asserts the inline `grid-template-columns` is set.

- [ ] **Step 5d: `useConfirm`** — fresh hook over DS `Dialog` (DS Dialog API: `open`, `onClose`, `title`, `description`, `footer`). Returns a callable with `.dialog`. Test: calling `confirm({title})` renders the dialog; clicking the confirm button resolves `true`.
```tsx
import * as React from 'react'
import { Dialog, Button } from '@connor-adams/designsystem'

type Opts = { title: React.ReactNode; description?: React.ReactNode; confirmLabel?: string; cancelLabel?: string; destructive?: boolean }
type ConfirmFn = ((o: Opts) => Promise<boolean>) & { dialog: React.ReactNode }

export function useConfirm(): ConfirmFn {
  const [state, setState] = React.useState<(Opts & { resolve: (v: boolean) => void }) | null>(null)
  const settle = (v: boolean) => setState((s) => { s?.resolve(v); return null })
  const dialog = state ? (
    <Dialog open onClose={() => settle(false)} title={state.title} description={state.description}
      footer={<>
        <Button variant="outline" onClick={() => settle(false)}>{state.cancelLabel ?? 'Cancel'}</Button>
        <Button variant={state.destructive ? 'destructive' : 'primary'} onClick={() => settle(true)}>{state.confirmLabel ?? 'Confirm'}</Button>
      </>} />
  ) : null
  return Object.assign((o: Opts) => new Promise<boolean>((resolve) => setState({ ...o, resolve })), { dialog }) as ConfirmFn
}
```
> If the DS `Dialog` prop names differ from the captured signature, adjust to the DS's actual API (verify against the installed `@connor-adams/designsystem` types) — do NOT reach for `@cashflow/ui`.

- [ ] **Step 5e: Barrel + commit**

`index.ts` re-exports the four. Run `yarn workspace frontend run test ds-extras` → all green.
```bash
git add frontend/src/lib/ds-extras
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH git commit -m "feat(ui): fresh ds-extras (EmptyTableRow, SkeletonRow, Grid, useConfirm) over DS primitives"
```

---

### Task 6: Repoint the 1:1 call sites (mechanical, batched)

Repoint the ~140 files that use only directly-mappable symbols (`Button, Card+sub, Badge, Input, EmptyState, Alert, Label, Textarea, Table+sub, Skeleton, SkeletonText`). Batch in reviewable chunks (e.g. by top-level dir). Each chunk is a sub-task guarded by that area's existing tests + a fresh characterization test where none exists.

**Per-chunk loop:**
- [ ] **Step 1:** Ensure a characterization test exists for each page in the chunk (header + key rows render). Write where missing (mirror `AccountsPage.test.tsx`). Run → PASS against current code.
- [ ] **Step 2:** Replace `from '@cashflow/ui'` → `from '@connor-adams/designsystem'` in the chunk, applying the Task 4 delta notes (e.g. `aria-invalid`→`invalid`, unwrap `asChild`, `NativeSelectOption`→`<option>`). Use the gap helpers from `@/lib/ds-extras` for any gap symbol.
- [ ] **Step 3:** Run the chunk's tests + `yarn workspace frontend run lint` → green.
- [ ] **Step 4:** Commit per chunk: `refactor(ui): repoint <area> onto @connor-adams/designsystem`.

> Track progress: `grep -rl "@cashflow/ui" frontend/src --include=*.tsx | wc -l` should strictly decrease each chunk.

---

### Task 7: Repoint the API-delta + domain call sites

Handle the harder call sites: `Tabs`/`TabPanel`, `Dialog`/`useConfirm`, `NativeSelect(Option)`, and the domain components `StatCard`/`Sparkline`/`LetterAvatar` (DS provides its own; decide DS-native vs keep-local).

- [ ] **Step 1: Tabs/TabPanel** — convert each `<Tabs items value onValueChange>` + `<TabPanel value active>` pair to DS `Tabs` (items/value/onValueChange) + conditional body (`{active === 'x' && <…/>}`). Guarded by the page's characterization test.
- [ ] **Step 2: Dialog/useConfirm** — replace compound `Dialog` children with the DS prop-based `Dialog`; replace `useConfirm` imports with `@/lib/ds-extras`. Test confirm flows.
- [ ] **Step 3: NativeSelect** — drop `NativeSelectOption`, use plain `<option>` children under DS `NativeSelect` (or its `options` prop).
- [ ] **Step 4: Domain components** — for `stat-card.tsx`/`sparkline.tsx`/`letter-avatar.tsx`: prefer the DS-native `StatCard`/`Sparkline`/`LetterAvatar` if the API covers usage; otherwise keep the local component but ensure it imports DS primitives (not `@cashflow/ui`). Repoint `frontend/src/components/ui/stat-card.tsx`'s `import { Card } from '@cashflow/ui'` → `@connor-adams/designsystem`. Re-run consumers' tests.
- [ ] **Step 5: Commit** per logical group.

---

### Task 8: Prove zero @cashflow/ui imports remain

- [ ] **Step 1: Assert none left**
```bash
grep -rl "@cashflow/ui" frontend/src --include=*.tsx --include=*.ts | tee /tmp/remaining.txt
test ! -s /tmp/remaining.txt && echo "CLEAN" || echo "STILL IMPORTING — finish Tasks 6/7"
```
Expected: `CLEAN`.
- [ ] **Step 2: Full gates** — `yarn workspace frontend run lint && yarn workspace frontend run test && yarn workspace frontend run build` → all green.
- [ ] **Step 3: Commit** any final fixes.

---

### Task 9: Visual-regression review pass (manual checkpoint)

The DS is prototype-grade (risk #2). Before deleting `@cashflow/ui`, eyeball the migrated app.

- [ ] **Step 1:** `yarn dev`; walk the high-traffic pages (Dashboard, Transactions, Portfolio, Reports, Accounts) in light + `data-theme="dark"`. Note regressions (hover/focus loss, inline-style overrides, spacing).
- [ ] **Step 2:** File follow-up issues for regressions worth fixing in the DS repo (not blocking the delete). Surface the list to Connor.

---

### Task 10: Delete @cashflow/ui

Only once Task 8 reports `CLEAN` and Task 9 is reviewed.

**Files:**
- Delete: `packages/ui/`
- Modify: root `package.json` workspaces (if `packages/ui` is listed), `frontend/package.json` (remove `@cashflow/ui` dep if still present), `yarn.lock`.

- [ ] **Step 1:** Remove the dependency + workspace entry; delete the directory.
```bash
corepack yarn workspace frontend remove @cashflow/ui 2>/dev/null || true
git rm -r packages/ui
```
- [ ] **Step 2:** `corepack yarn install` → clean lockfile. `yarn ci` (typecheck + tests + builds) → green.
- [ ] **Step 3:** Grep the whole repo for stragglers: `grep -rl "@cashflow/ui" . --include=*.ts --include=*.tsx --include=*.json --include=*.css | grep -v node_modules` → empty.
- [ ] **Step 4: Commit**
```bash
git add -A
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH git commit -m "chore(ui): delete @cashflow/ui — frontend now consumes @connor-adams/designsystem"
```

---

## Self-Review

- **Spec coverage:** consume DS → Tasks 2–3; token layer rescue → Task 1 (critical path); gap symbols → Task 5; repoint all 201 files → Tasks 6–7; zero-import proof → Task 8; delete `@cashflow/ui` → Task 10; prototype-quality risk → Task 9. ✓
- **"Don't use @cashflow/ui":** every helper in Task 5 and the theme layer in Task 1 are authored fresh over `@connor-adams/*` / Tailwind — none copy `packages/ui`. ✓
- **Sequencing:** delete (Task 10) is gated on `CLEAN` (Task 8); app builds at every prior step (token layer moved in Task 1 before components in Tasks 6–7). ✓
- **Open items for the reviewer:** (1) confirm the DS is actually published/installable (Task 2 Step 1 gate); (2) accept expected visual regressions from the prototype DS, or decide to harden the DS first after all; (3) confirm `data-theme` dark-mode wiring matches the app's current theme switcher.
