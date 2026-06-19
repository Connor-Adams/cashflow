# @cashflow/ui Publishable Package Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract Cashflow's generic UI primitives + design tokens into a standalone, npm-publishable `@cashflow/ui` workspace package that ships precompiled CSS (no Tailwind required downstream), with the cashflow frontend as its first consumer.

**Architecture:** New `packages/ui` Yarn-4 workspace. Components are authored in Tailwind v4 utility classes (unchanged from today). At publish time a Tailwind CLI build compiles **only** the utilities the components use — plus the token layer, custom `@utility` definitions, and keyframes — into a single standalone stylesheet `dist/cashflow-ui.css` with **no preflight/reset** (so it never clobbers a consumer's page). Component JS/TS is built to ESM + `.d.ts` by tsup. Runtime class computation (`cva`, `clsx`, `tailwind-merge`) is bundled as regular deps; `react`, `react-dom`, `@radix-ui/react-slot`, `lucide-react` are peerDependencies. The frontend imports both the JS and the CSS from the package and deletes its local copies; the token `:root` blocks move out of `frontend/src/index.css` into the package and the frontend imports them back.

**Tech Stack:** React 19, TypeScript 5.9, Tailwind v4 (`@tailwindcss/cli`), tsup, Vitest + Testing Library + jsdom, Yarn 4 workspaces.

## Global Constraints

- Package name: `@cashflow/ui`. Initial version `0.0.0`. `"private": false` (publishable) but do NOT run a real `npm publish` in this plan — dry-run only.
- Yarn 4.17 workspaces; run everything from repo root. Never add a nested `node_modules`.
- React `^19.2.4`. Tailwind `^4.2.4`. TypeScript `~5.9.3`. Match versions already pinned in `frontend/package.json`.
- Components move **verbatim** — same class strings, same behavior. Only import paths change (`@/lib/utils` → `../lib/cn`). No restyling, no API changes.
- Scope = the **generic 14 only**: `button, card, input, textarea, label, badge, alert, table, tabs, skeleton, empty-state, dialog, grid, native-select`. Domain components (`DeltaBadge`, `delta-tone`, `filter-bar`, `stat-card`, `metric-stat`, `sparkline`, `allocation-donut`, `letter-avatar`, `pct-delta-cell`, `txn-merchant-cell`, `table-card`, `filter-card`, `page-header`, `section-header`, `collapsible-card`, `security-logo`, `tree`, `toast`) STAY in `frontend/`.
- Precompiled CSS must exclude Tailwind preflight (no global reset shipped to consumers).
- Commit message author is Connor only — no `Co-Authored-By` trailers.
- TDD: every component move gets a smoke test that fails before the move (module-not-found / missing class) and passes after.

---

## File Structure

```
packages/ui/
  package.json                 # @cashflow/ui manifest, exports map, build scripts
  tsconfig.json                # extends root settings, react-jsx, strict
  tsup.config.ts               # ESM + .d.ts build of src/index.ts
  vitest.config.ts             # jsdom env, testing-library
  vitest.setup.ts              # @testing-library/jest-dom
  src/
    index.ts                   # public barrel — re-exports all 14 primitives + types
    lib/
      cn.ts                    # clsx + tailwind-merge helper (moved from frontend)
    styles/
      tokens.css               # :root light + :root[data-theme="dark"] token blocks
      theme.css                # @theme inline (radius, breakpoint, colors, typography, button/border tokens)
      utilities.css            # @utility bg-button-*, border-*, touch-hitbox + skeleton keyframes/.skeleton-shimmer
      build.css                # Tailwind entry: layered imports (NO preflight) + @source globs + the three files above
    components/
      button.tsx card.tsx input.tsx textarea.tsx label.tsx badge.tsx
      alert.tsx table.tsx tabs.tsx skeleton.tsx empty-state.tsx
      dialog.tsx grid.tsx native-select.tsx
    components/__tests__/       # smoke tests per primitive (+ moved badge/table/grid tests)
  dist/                        # build output (gitignored): index.js, index.d.ts, cashflow-ui.css

frontend/src/index.css         # token :root blocks REMOVED; imports @cashflow/ui token css instead
frontend/src/components/ui/    # the 14 moved files DELETED; re-export shim optional (see Task 8)
```

---

### Task 1: Scaffold the `packages/ui` workspace

**Files:**
- Create: `packages/ui/package.json`
- Create: `packages/ui/tsconfig.json`
- Create: `packages/ui/tsup.config.ts`
- Create: `packages/ui/vitest.config.ts`
- Create: `packages/ui/vitest.setup.ts`
- Create: `packages/ui/src/index.ts`
- Create: `packages/ui/src/__smoke__/scaffold.test.ts`
- Modify: `package.json` (root) — add `"packages/*"` to `workspaces`
- Create: `packages/ui/.gitignore`

**Interfaces:**
- Produces: workspace `@cashflow/ui` resolvable via Yarn; `src/index.ts` barrel (empty for now); scripts `build`, `build:css`, `build:js`, `test`, `typecheck`.

- [ ] **Step 1: Add the package glob to root workspaces**

Modify root `package.json` `workspaces` array to:

```json
  "workspaces": [
    "backend",
    "frontend",
    "shared",
    "packages/*"
  ],
```

- [ ] **Step 2: Write the package manifest**

Create `packages/ui/package.json`:

```json
{
  "name": "@cashflow/ui",
  "version": "0.0.0",
  "private": false,
  "type": "module",
  "license": "UNLICENSED",
  "sideEffects": ["*.css"],
  "files": ["dist"],
  "main": "./dist/index.js",
  "module": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    },
    "./styles.css": "./dist/cashflow-ui.css"
  },
  "scripts": {
    "build": "yarn build:js && yarn build:css",
    "build:js": "tsup",
    "build:css": "tailwindcss -i ./src/styles/build.css -o ./dist/cashflow-ui.css --minify",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "prepublishOnly": "yarn build"
  },
  "dependencies": {
    "class-variance-authority": "^0.7.1",
    "clsx": "^2.1.1",
    "tailwind-merge": "^3.6.0"
  },
  "peerDependencies": {
    "@radix-ui/react-slot": "^1.2.4",
    "lucide-react": "^1.14.0",
    "react": "^19.2.4",
    "react-dom": "^19.2.4"
  },
  "devDependencies": {
    "@radix-ui/react-slot": "^1.2.4",
    "@tailwindcss/cli": "^4.2.4",
    "@testing-library/jest-dom": "^6.6.3",
    "@testing-library/react": "^16.3.0",
    "@types/react": "^19.2.14",
    "@types/react-dom": "^19.2.3",
    "jsdom": "^26.1.0",
    "lucide-react": "^1.14.0",
    "react": "^19.2.4",
    "react-dom": "^19.2.4",
    "tailwindcss": "^4.2.4",
    "tsup": "^8.3.5",
    "typescript": "~5.9.3",
    "vitest": "^3.2.4"
  }
}
```

- [ ] **Step 3: Write tsconfig, build, and test configs**

Create `packages/ui/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "jsx": "react-jsx",
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": true,
    "verbatimModuleSyntax": true
  },
  "include": ["src"]
}
```

Create `packages/ui/tsup.config.ts`:

```ts
import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: false,
  external: ['react', 'react-dom', '@radix-ui/react-slot', 'lucide-react'],
})
```

Create `packages/ui/vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'jsdom',
    setupFiles: ['./vitest.setup.ts'],
    globals: true,
  },
})
```

Create `packages/ui/vitest.setup.ts`:

```ts
import '@testing-library/jest-dom/vitest'
```

Create `packages/ui/.gitignore`:

```
dist
```

- [ ] **Step 4: Write an empty barrel + scaffold test**

Create `packages/ui/src/index.ts`:

```ts
// Public API barrel for @cashflow/ui. Primitives are added in later tasks.
export {}
```

Create `packages/ui/src/__smoke__/scaffold.test.ts`:

```ts
import { describe, it, expect } from 'vitest'

describe('package scaffold', () => {
  it('loads the barrel module without throwing', async () => {
    const mod = await import('../index')
    expect(mod).toBeTypeOf('object')
  })
})
```

- [ ] **Step 5: Install + run the scaffold test (verify it passes)**

Run:
```bash
cd /Users/connoradams/Developer/cashflow/.claude/worktrees/elated-aryabhata-f3b2fb && yarn install
yarn workspace @cashflow/ui run test
```
Expected: install resolves `@cashflow/ui` as a workspace; vitest reports 1 passing test.

- [ ] **Step 6: Verify typecheck passes**

Run: `yarn workspace @cashflow/ui run typecheck`
Expected: exit 0, no errors.

- [ ] **Step 7: Commit**

```bash
git add package.json packages/ui
git commit -m "feat(ui): scaffold @cashflow/ui workspace package"
```

---

### Task 2: Extract the token + theme + utilities CSS and build standalone stylesheet

**Files:**
- Create: `packages/ui/src/styles/tokens.css`
- Create: `packages/ui/src/styles/theme.css`
- Create: `packages/ui/src/styles/utilities.css`
- Create: `packages/ui/src/styles/build.css`
- Create: `packages/ui/scripts/assert-css.mjs`

**Interfaces:**
- Produces: `dist/cashflow-ui.css` (standalone, no preflight) containing token vars, `@theme` mappings, custom utilities, skeleton shimmer, and any Tailwind utilities used by the components. Consumed by Task 8 (frontend imports `@cashflow/ui/styles.css`).

- [ ] **Step 1: Copy the token blocks verbatim into `tokens.css`**

Create `packages/ui/src/styles/tokens.css` with the **exact** contents of `frontend/src/index.css` lines 12–275 (both `:root, :root[data-theme="light"]` and `:root[data-theme="dark"]` blocks, including the legacy aliases — keep them; the frontend still references them). Do not edit values.

- [ ] **Step 2: Copy the `@theme inline` block into `theme.css`**

Create `packages/ui/src/styles/theme.css` with the **exact** contents of `frontend/src/index.css` lines 284–412 (the entire `@theme inline { ... }` block — radius, breakpoint, color mappings, button/border semantic tokens, typography scale, chart + semantic color utilities).

- [ ] **Step 3: Copy the custom utilities + skeleton shimmer into `utilities.css`**

Create `packages/ui/src/styles/utilities.css` with the **exact** contents of `frontend/src/index.css` lines 414–447 (the three `@utility` blocks: `bg-button-*`, `border-*`, `touch-hitbox`) followed by the skeleton shimmer rule + keyframes (lines 499–523: `@keyframes skeletonShimmer`, `.skeleton-shimmer`, and its `prefers-reduced-motion` override). Do NOT copy `.livingBg` / `livingGradientDrift` (dashboard-only, stays in frontend).

- [ ] **Step 4: Write the Tailwind build entry with NO preflight**

Create `packages/ui/src/styles/build.css`:

```css
/* Standalone stylesheet for @cashflow/ui consumers.
 * Layered imports WITHOUT tailwindcss/preflight so we never reset the host page.
 * @source points Tailwind at our component class strings so only used utilities
 * are emitted. */
@layer theme, base, components, utilities;

@import "tailwindcss/theme.css" layer(theme);
@import "tailwindcss/utilities.css" layer(utilities) source(none);

@source "../components/**/*.{ts,tsx}";

@import "./tokens.css";
@import "./theme.css";
@import "./utilities.css";
```

- [ ] **Step 5: Write a build-output assertion script**

Create `packages/ui/scripts/assert-css.mjs`:

```js
// Verifies the compiled stylesheet carries the load-bearing pieces.
import { readFileSync } from 'node:fs'

const css = readFileSync(new URL('../dist/cashflow-ui.css', import.meta.url), 'utf8')
const required = [
  '#9B2D3A',          // oxblood-500 token value
  '--primary',        // semantic token present
  'skeleton-shimmer', // keyframe class shipped
]
const missing = required.filter((needle) => !css.includes(needle))
if (missing.length > 0) {
  console.error('cashflow-ui.css missing:', missing.join(', '))
  process.exit(1)
}
// Preflight must NOT be present (no global reset shipped).
if (/\*,\s*::before,\s*::after\s*{[^}]*box-sizing:\s*border-box/.test(css)) {
  console.error('cashflow-ui.css unexpectedly contains preflight reset')
  process.exit(1)
}
console.log('cashflow-ui.css OK (%d bytes)', css.length)
```

- [ ] **Step 6: Build the CSS and run the assertion**

Run:
```bash
yarn workspace @cashflow/ui run build:css
node packages/ui/scripts/assert-css.mjs
```
Expected: `cashflow-ui.css OK (<n> bytes)`. (At this point few utilities are emitted because no components exist yet — that's fine; tokens + shimmer must be present.)

- [ ] **Step 7: Commit**

```bash
git add packages/ui/src/styles packages/ui/scripts/assert-css.mjs
git commit -m "feat(ui): extract design tokens + theme into @cashflow/ui standalone css"
```

---

### Task 3: Move the `cn` helper into the package

**Files:**
- Create: `packages/ui/src/lib/cn.ts`
- Create: `packages/ui/src/lib/cn.test.ts`

**Interfaces:**
- Produces: `cn(...inputs: ClassValue[]) => string`, imported by every component via `../lib/cn`.

- [ ] **Step 1: Write the failing test**

Create `packages/ui/src/lib/cn.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { cn } from './cn'

describe('cn', () => {
  it('merges and dedupes conflicting tailwind classes', () => {
    expect(cn('px-2', 'px-4')).toBe('px-4')
  })
  it('drops falsy values', () => {
    expect(cn('a', false, undefined, 'b')).toBe('a b')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `yarn workspace @cashflow/ui run test -- cn`
Expected: FAIL — cannot find module `./cn`.

- [ ] **Step 3: Create the helper (verbatim from frontend)**

Create `packages/ui/src/lib/cn.ts`:

```ts
import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `yarn workspace @cashflow/ui run test -- cn`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/lib
git commit -m "feat(ui): add cn class-merge helper"
```

---

### Task 4: Move the CVA primitives (button, badge)

**Files:**
- Create: `packages/ui/src/components/button.tsx`
- Create: `packages/ui/src/components/badge.tsx`
- Create: `packages/ui/src/components/__tests__/button.test.tsx`
- Move: `frontend/src/components/ui/badge.test.tsx` → `packages/ui/src/components/__tests__/badge.test.tsx`
- Modify: `packages/ui/src/index.ts`

**Interfaces:**
- Consumes: `cn` from `../lib/cn`.
- Produces: `Button`, `buttonVariants`, `ButtonProps`; `Badge`, `badgeVariants`. Consumed by Task 6 (`dialog` imports `Button`).

- [ ] **Step 1: Copy button + badge verbatim, fixing only the cn import**

Copy `frontend/src/components/ui/button.tsx` → `packages/ui/src/components/button.tsx`. Change the import line `import { cn } from "@/lib/utils"` to `import { cn } from "../lib/cn"`. Leave everything else (the `cva` calls, all variant class strings, the `Slot` import) unchanged.

Copy `frontend/src/components/ui/badge.tsx` → `packages/ui/src/components/badge.tsx`. Change `import { cn } from '@/lib/utils'` to `import { cn } from '../lib/cn'`.

- [ ] **Step 2: Move the badge test and write a button smoke test**

```bash
git mv frontend/src/components/ui/badge.test.tsx packages/ui/src/components/__tests__/badge.test.tsx
```
In the moved `badge.test.tsx`, fix the import of the component to `from '../badge'`.

Create `packages/ui/src/components/__tests__/button.test.tsx`:

```tsx
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Button } from '../button'

describe('Button', () => {
  it('renders children and the primary variant class', () => {
    render(<Button>Save</Button>)
    const btn = screen.getByRole('button', { name: 'Save' })
    expect(btn).toBeInTheDocument()
    expect(btn.className).toContain('bg-button-primary')
  })
  it('renders as a slotted child when asChild is set', () => {
    render(<Button asChild><a href="/x">Link</a></Button>)
    expect(screen.getByRole('link', { name: 'Link' })).toHaveClass('bg-button-primary')
  })
})
```

- [ ] **Step 3: Export from the barrel**

Edit `packages/ui/src/index.ts`:

```ts
export { Button, buttonVariants, type ButtonProps } from './components/button'
export { Badge, badgeVariants } from './components/badge'
```

(If `ButtonProps` is not exported from `button.tsx`, add `export` to its interface there; do not rename it.)

- [ ] **Step 4: Run the tests**

Run: `yarn workspace @cashflow/ui run test -- button badge`
Expected: PASS (button smoke + badge tests).

- [ ] **Step 5: Typecheck**

Run: `yarn workspace @cashflow/ui run typecheck`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add packages/ui/src frontend/src/components/ui/badge.test.tsx
git commit -m "feat(ui): move button + badge primitives into @cashflow/ui"
```

---

### Task 5: Move the cn-only leaf primitives

Primitives in this task: `card, input, textarea, label, alert, skeleton, empty-state, grid, native-select, table`. Each imports only `cn` (no CVA, no siblings). `table` and `grid` have existing colocated tests to move.

**Files:**
- Create: `packages/ui/src/components/{card,input,textarea,label,alert,skeleton,empty-state,grid,native-select,table}.tsx`
- Move: `frontend/src/components/ui/table.test.tsx` → `packages/ui/src/components/__tests__/table.test.tsx`
- Move: `frontend/src/components/ui/grid.test.tsx` → `packages/ui/src/components/__tests__/grid.test.tsx`
- Create: `packages/ui/src/components/__tests__/leaves.test.tsx`
- Modify: `packages/ui/src/index.ts`

**Interfaces:**
- Consumes: `cn` from `../lib/cn`.
- Produces: `Card, CardHeader, CardTitle, CardDescription, CardContent`; `Input`; `Textarea`; `Label`; `Alert`; `Skeleton, SkeletonText, SkeletonRow`; `EmptyState, EmptyTableRow`; `Grid`; `NativeSelect, NativeSelectOption`; `Table, TableHeader, TableBody, TableHead, TableRow, TableCell`.

- [ ] **Step 1: Copy all ten files verbatim, fixing the cn import**

For each of `card, input, textarea, label, alert, skeleton, empty-state, grid, native-select, table`: copy `frontend/src/components/ui/<name>.tsx` → `packages/ui/src/components/<name>.tsx` and change its `cn` import to `import { cn } from '../lib/cn'`. Change nothing else.

- [ ] **Step 2: Move existing tests and fix their imports**

```bash
git mv frontend/src/components/ui/table.test.tsx packages/ui/src/components/__tests__/table.test.tsx
git mv frontend/src/components/ui/grid.test.tsx packages/ui/src/components/__tests__/grid.test.tsx
```
In each moved file, change the component import to `from '../<name>'` (e.g. `from '../table'`).

- [ ] **Step 3: Write a smoke test covering the untested leaves**

Create `packages/ui/src/components/__tests__/leaves.test.tsx`:

```tsx
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Card } from '../card'
import { Input } from '../input'
import { Alert } from '../alert'
import { Skeleton } from '../skeleton'
import { EmptyState } from '../empty-state'

describe('leaf primitives render', () => {
  it('Card renders content', () => {
    render(<Card>hello</Card>)
    expect(screen.getByText('hello')).toBeInTheDocument()
  })
  it('Input has the rounded bordered field classes', () => {
    render(<Input placeholder="amount" />)
    expect(screen.getByPlaceholderText('amount').className).toContain('border-input')
  })
  it('Alert error variant uses role=alert', () => {
    render(<Alert variant="error">boom</Alert>)
    expect(screen.getByRole('alert')).toHaveTextContent('boom')
  })
  it('Skeleton applies the shimmer class', () => {
    const { container } = render(<Skeleton className="h-4 w-10" />)
    expect(container.firstChild).toHaveClass('skeleton-shimmer')
  })
  it('EmptyState shows its title', () => {
    render(<EmptyState title="Nothing here" />)
    expect(screen.getByText('Nothing here')).toBeInTheDocument()
  })
})
```

(If the `Alert` prop name for variant differs, or `EmptyState`'s title prop differs, adjust the test to the actual prop names found in the copied source — do not change the components.)

- [ ] **Step 4: Export all from the barrel**

Append to `packages/ui/src/index.ts`:

```ts
export { Card, CardHeader, CardTitle, CardDescription, CardContent } from './components/card'
export { Input } from './components/input'
export { Textarea } from './components/textarea'
export { Label } from './components/label'
export { Alert } from './components/alert'
export { Skeleton, SkeletonText, SkeletonRow } from './components/skeleton'
export { EmptyState, EmptyTableRow } from './components/empty-state'
export { Grid } from './components/grid'
export { NativeSelect, NativeSelectOption } from './components/native-select'
export {
  Table, TableHeader, TableBody, TableHead, TableRow, TableCell,
} from './components/table'
```

(Cross-check each named export against the actual `export` statements in the copied files; correct any name that differs — do not rename in the source.)

- [ ] **Step 5: Run the tests**

Run: `yarn workspace @cashflow/ui run test`
Expected: PASS (scaffold, cn, button, badge, table, grid, leaves).

- [ ] **Step 6: Typecheck**

Run: `yarn workspace @cashflow/ui run typecheck`
Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
git add packages/ui/src frontend/src/components/ui
git commit -m "feat(ui): move leaf primitives (card, input, table, …) into @cashflow/ui"
```

---

### Task 6: Move the composite primitives (tabs, dialog)

`dialog` imports the sibling `Button`; `tabs` is standalone. Both import `cn`.

**Files:**
- Create: `packages/ui/src/components/tabs.tsx`
- Create: `packages/ui/src/components/dialog.tsx`
- Create: `packages/ui/src/components/__tests__/dialog.test.tsx`
- Create: `packages/ui/src/components/__tests__/tabs.test.tsx`
- Modify: `packages/ui/src/index.ts`

**Interfaces:**
- Consumes: `cn` from `../lib/cn`, `Button` from `./button`.
- Produces: tabs exports (`Tabs` + types) and dialog exports (`Dialog, DialogHeader, DialogTitle, DialogDescription, DialogBody, DialogFooter, useConfirm` — confirm against source).

- [ ] **Step 1: Copy tabs + dialog verbatim, fixing imports**

Copy `frontend/src/components/ui/tabs.tsx` → `packages/ui/src/components/tabs.tsx`; change cn import to `../lib/cn`.

Copy `frontend/src/components/ui/dialog.tsx` → `packages/ui/src/components/dialog.tsx`; change `import { cn } from '@/lib/utils'` → `import { cn } from '../lib/cn'` and keep `import { Button } from './button'` (already relative — verify the path resolves within `components/`).

- [ ] **Step 2: Write smoke tests**

Create `packages/ui/src/components/__tests__/tabs.test.tsx`:

```tsx
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Tabs } from '../tabs'

describe('Tabs', () => {
  it('renders tab labels and marks the active one selected', () => {
    render(
      <Tabs
        value="a"
        onValueChange={() => {}}
        items={[
          { value: 'a', label: 'Alpha' },
          { value: 'b', label: 'Beta' },
        ]}
      />,
    )
    expect(screen.getByRole('tab', { name: 'Alpha' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tab', { name: 'Beta' })).toHaveAttribute('aria-selected', 'false')
  })
})
```

(Adjust the `Tabs` prop shape to match the actual `items`/`value`/`onValueChange` signature in the copied source.)

Create `packages/ui/src/components/__tests__/dialog.test.tsx`:

```tsx
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Dialog, DialogTitle } from '../dialog'

describe('Dialog', () => {
  it('renders its title when open', () => {
    render(
      <Dialog open onOpenChange={() => {}}>
        <DialogTitle>Confirm delete</DialogTitle>
      </Dialog>,
    )
    expect(screen.getByText('Confirm delete')).toBeInTheDocument()
  })
})
```

(Adjust `Dialog`'s open/onOpenChange prop names and the sub-component imports to match the copied source.)

- [ ] **Step 3: Export from the barrel**

Append to `packages/ui/src/index.ts` the exact exports declared in the copied `tabs.tsx` and `dialog.tsx` (e.g.):

```ts
export { Tabs } from './components/tabs'
export {
  Dialog, DialogHeader, DialogTitle, DialogDescription, DialogBody, DialogFooter, useConfirm,
} from './components/dialog'
```

- [ ] **Step 4: Run tests + typecheck**

Run: `yarn workspace @cashflow/ui run test && yarn workspace @cashflow/ui run typecheck`
Expected: all PASS, typecheck exit 0.

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src
git commit -m "feat(ui): move tabs + dialog composite primitives into @cashflow/ui"
```

---

### Task 7: Build the package end-to-end (JS + CSS) and verify the artifact

**Files:**
- Modify: `packages/ui/scripts/assert-css.mjs` (extend assertions)
- Create: `packages/ui/scripts/assert-js.mjs`

**Interfaces:**
- Produces: `dist/index.js`, `dist/index.d.ts`, `dist/cashflow-ui.css` — the publishable artifact consumed by Task 8 and Task 9.

- [ ] **Step 1: Extend the CSS assertion to require component utilities**

Now that components exist, the compiled CSS must contain utilities they use. Edit `packages/ui/scripts/assert-css.mjs` `required` array to add component-driven utilities:

```js
const required = [
  '#9B2D3A',
  '--primary',
  'skeleton-shimmer',
  '.rounded-lg',        // used by Button/Card
  '.bg-button-primary', // custom @utility emitted for Button
]
```

- [ ] **Step 2: Write a JS-artifact assertion**

Create `packages/ui/scripts/assert-js.mjs`:

```js
// Verifies the built ESM bundle exports the public primitives.
const mod = await import('../dist/index.js')
const expected = ['Button', 'Badge', 'Card', 'Input', 'Table', 'Dialog', 'Tabs', 'Alert']
const missing = expected.filter((name) => !(name in mod))
if (missing.length > 0) {
  console.error('dist/index.js missing exports:', missing.join(', '))
  process.exit(1)
}
console.log('dist/index.js OK — %d exports', Object.keys(mod).length)
```

Note: this imports React components in a non-DOM Node context; it only checks they are exported (named bindings exist), not that they render.

- [ ] **Step 3: Full build**

Run: `yarn workspace @cashflow/ui run build`
Expected: tsup emits `dist/index.js` + `dist/index.d.ts`; tailwind emits `dist/cashflow-ui.css`.

- [ ] **Step 4: Run both assertions**

Run:
```bash
node packages/ui/scripts/assert-css.mjs
node packages/ui/scripts/assert-js.mjs
```
Expected: both print `OK`.

- [ ] **Step 5: Commit**

```bash
git add packages/ui/scripts
git commit -m "test(ui): assert built css + js artifacts carry the public surface"
```

---

### Task 8: Rewire the frontend to consume `@cashflow/ui`

**Files:**
- Modify: `frontend/package.json` (add `@cashflow/ui` dependency)
- Modify: `frontend/src/index.css` (remove the moved token/theme/utility blocks; import package CSS + keep frontend-only CSS)
- Delete: the 14 moved files under `frontend/src/components/ui/`
- Create: `frontend/src/components/ui/index.ts` (re-export shim from `@cashflow/ui` — preserves existing deep imports without touching every call site)
- Modify: any frontend imports that referenced the deleted files by path (see Step 4)

**Interfaces:**
- Consumes: `@cashflow/ui` primitives + `@cashflow/ui/styles.css` + `@cashflow/ui/styles` token layer.
- Produces: a frontend that builds, tests, and lints green with zero local copies of the 14 primitives.

- [ ] **Step 1: Add the workspace dependency**

Edit `frontend/package.json` `dependencies`, add:

```json
    "@cashflow/ui": "*",
```

Run: `yarn install`
Expected: `@cashflow/ui` linked into the frontend.

- [ ] **Step 2: Move token CSS ownership to the package**

In `frontend/src/index.css`, DELETE lines 12–447 (the `:root` token blocks, the `@theme inline` block, and the three `@utility` blocks) AND the skeleton shimmer block (≈499–523) — everything now living in `@cashflow/ui`. KEEP: the top `@import "tailwindcss";` (line 1), `@custom-variant dark` (line 3), the `.livingBg` / `livingGradientDrift` block, and the global resets / body / `#root` / selection rules at the bottom.

At the top of `frontend/src/index.css`, immediately after `@import "tailwindcss";`, add:

```css
/* Design tokens, theme, and custom utilities now live in @cashflow/ui. */
@import "@cashflow/ui/styles.css";
```

Note: importing the package's compiled CSS brings the token `:root` layer + custom utilities. The frontend's own `@import "tailwindcss"` continues to generate utilities for app-level (non-primitive) code, which reference the same CSS vars.

- [ ] **Step 3: Delete the moved primitives and add a re-export shim**

```bash
git rm frontend/src/components/ui/{button,card,input,textarea,label,badge,alert,table,tabs,skeleton,empty-state,dialog,grid,native-select}.tsx
```

Create `frontend/src/components/ui/index.ts`:

```ts
// The generic primitives now live in @cashflow/ui. Re-export so existing
// `@/components/ui` imports keep resolving. Domain components below stay local.
export * from '@cashflow/ui'
```

- [ ] **Step 4: Repoint deep path imports**

Find any frontend imports that referenced a deleted file directly (e.g. `from '@/components/ui/button'`):

Run: `cd frontend && grep -rn "components/ui/\(button\|card\|input\|textarea\|label\|badge\|alert\|table\|tabs\|skeleton\|empty-state\|dialog\|grid\|native-select\)\b" src`

For each hit, change the import to come from `@cashflow/ui` (or `@/components/ui` which re-exports it). Do not touch imports of domain components (`stat-card`, `filter-bar`, etc.) that remain local.

- [ ] **Step 5: Run the frontend test suite**

Run: `yarn workspace frontend run test`
Expected: PASS. Investigate any failure caused by a missing re-export name (fix the barrel in `@cashflow/ui`, rebuild, rerun).

- [ ] **Step 6: Build the frontend (verifies CSS resolves at build time)**

Run: `yarn workspace @cashflow/ui run build && yarn workspace frontend run build`
Expected: both succeed. The frontend build must resolve `@cashflow/ui/styles.css`.

- [ ] **Step 7: Lint + palette guard**

Run: `yarn workspace frontend run lint && yarn workspace frontend run lint:palette`
Expected: exit 0. (If `lint:palette` now flags the moved token file, scope its file walk to `frontend/src` only — it should already, since the tokens left the frontend tree.)

- [ ] **Step 8: Commit**

```bash
git add frontend
git commit -m "refactor(frontend): consume primitives + tokens from @cashflow/ui"
```

---

### Task 9: Publish pipeline (dry-run) + docs

**Files:**
- Create: `packages/ui/README.md`
- Create: `packages/ui/.npmignore` (or rely on `files` allowlist)
- Modify: root `package.json` (`ci` script includes the ui package)

**Interfaces:**
- Produces: a package that passes `npm publish --dry-run` and a README documenting install + usage. No real publish performed.

- [ ] **Step 1: Wire the ui package into CI**

Edit the root `ci` script to build + test the package before the frontend (so the frontend build can resolve it). Insert after the shared test, before backend, e.g.:

```
"ci": "yarn test:workflows && yarn workspace @cashflow/shared run test && yarn workspace @cashflow/ui run typecheck && yarn workspace @cashflow/ui run test && yarn workspace @cashflow/ui run build && yarn workspace cashflow-backend run typecheck && yarn workspace cashflow-backend run test && yarn workspace cashflow-backend run test:integration && yarn workspace cashflow-backend run build && yarn workspace frontend run test && yarn workspace frontend run build && yarn workspace frontend run lint && yarn workspace frontend run lint:palette",
```

- [ ] **Step 2: Write the README**

Create `packages/ui/README.md` documenting: install (`yarn add @cashflow/ui`), the required `import '@cashflow/ui/styles.css'` once at app root, a `<Button>` usage snippet, the dark-mode note (`data-theme="dark"` on a root element), and the peerDependency list. Seed the content from `cashflow-design-system.md` at repo root (sections 1, 5, 7).

- [ ] **Step 3: Add the files allowlist guard**

Confirm `packages/ui/package.json` has `"files": ["dist"]` (set in Task 1). Create `packages/ui/.npmignore` as a belt-and-suspenders:

```
src
scripts
*.config.ts
vitest.setup.ts
tsconfig.json
```

- [ ] **Step 4: Dry-run the publish**

Run:
```bash
yarn workspace @cashflow/ui run build
cd packages/ui && npm publish --dry-run
```
Expected: npm lists the tarball contents — it must include `dist/index.js`, `dist/index.d.ts`, `dist/cashflow-ui.css`, `package.json`, `README.md`, and NOTHING from `src/`.

- [ ] **Step 5: Run the full CI locally**

Run: `yarn ci`
Expected: green end to end.

- [ ] **Step 6: Commit**

```bash
git add packages/ui/README.md packages/ui/.npmignore package.json
git commit -m "chore(ui): add publish metadata, README, and CI wiring for @cashflow/ui"
```

---

## Self-Review

**Spec coverage:**
- Monorepo workspace (not separate repo) → Task 1. ✓
- Full DS = tokens + generic components → tokens (Task 2), components (Tasks 4–6). ✓
- Precompiled CSS, no Tailwind downstream, no preflight → Task 2 Step 4 (layered import, no preflight) + Task 7 assertion. ✓
- Domain components excluded → Global Constraints + Task 5/8 scope. ✓
- Frontend dogfoods the package → Task 8. ✓
- Publishable, but no real publish → Task 9 dry-run. ✓
- No `Co-Authored-By` → Global Constraints; commit commands carry no trailer. ✓

**Placeholder scan:** Component moves are specified as verbatim copies with the one exact import-line change; configs and tests are given in full. The only deliberately deferred specifics are export-name cross-checks ("confirm against source") — flagged because the exact named exports must be read from each file at move time; the barrel edits show the expected names to verify, not invent.

**Type/name consistency:** `cn` signature identical across Task 3 and all consumers. `Button`/`ButtonProps` produced in Task 4, consumed by `dialog` in Task 6 and barrel in Task 7/8. CSS export path `@cashflow/ui/styles.css` consistent between Task 1 exports map, Task 8 frontend import, and Task 9 README. `dist/cashflow-ui.css` filename consistent across Task 1 (`build:css` output), Task 2 (assertion), Task 7, Task 9.

**Known risk to watch during execution:** export names in the barrel (Tasks 4–6) must match each source file's actual `export` statements — verify by reading each file's exports before writing the barrel line, since a mismatch surfaces only at Task 8 frontend build time.
