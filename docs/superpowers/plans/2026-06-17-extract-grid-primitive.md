# Extract Grid Primitive Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]` checkboxes.

**Goal:** Extract the app's most-repeated layout pattern — the intrinsic responsive auto-fit/minmax grid (12 hand-rolled instances across App.css: stat grids, `reportsGrid`, `formGrid`, `aiVisibilityList`, …) — into one shared `Grid` design-system primitive, show it in the gallery, and adopt it on the 3 already-swept pages.

**Architecture:** `Grid` is a thin layout primitive in `frontend/src/components/ui/grid.tsx`. It emits `display:grid` + `repeat(auto-fit|auto-fill, minmax(<floor>, 1fr))` via an encapsulated inline `gridTemplateColumns` (a free numeric `minItemWidth` can't be a JIT Tailwind class; inline style inside a primitive is the established pattern — see `Alert`/`StatCard`/`MetricStat`). Gap is a token utility class. Wander-flavored API (props-driven), but auto-fit mechanism (NOT Wander's column-based Grid — that's a different pattern the app doesn't use).

**Tech Stack:** React 19, Tailwind v4, vitest. Reference: existing `ui/` primitives (card.tsx, alert.tsx, stat-card.tsx).

## Global Constraints
- Run from repo root: `/Users/connoradams/Developer/cashflow/.claude/worktrees/extract-grid-primitive` (node_modules symlinked — `yarn workspace frontend run test` works).
- Commit husky workaround, exact prefix: `PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH git commit -m "…"` (if `-m` blocked, `git commit --file=<tmpfile>`). Sole author — NEVER add Co-Authored-By.
- Token-only color; the ONE permitted inline style is `gridTemplateColumns` inside the `Grid` primitive itself.
- Adoption must be look-preserving against the current arbitrary-value classes on the swept pages.

## Grid API (build exactly this)
```tsx
type GridProps = React.ComponentProps<'div'> & {
  minItemWidth?: number            // px; default 180. Min track width before wrapping.
  gap?: 'sm' | 'md' | 'lg'         // gap-2 / gap-3 / gap-4; default 'md'
  fill?: boolean                   // auto-fill instead of auto-fit; default false (auto-fit)
  responsiveFloor?: boolean        // use minmax(min(100%, Npx), 1fr) to avoid overflow on narrow screens; default true
}
```
- `gap` map (lookup table — JIT-safe literals): `{ sm: 'gap-2', md: 'gap-3', lg: 'gap-4' }`.
- gridTemplateColumns: `repeat(${fill ? 'auto-fill' : 'auto-fit'}, minmax(${responsiveFloor ? \`min(100%, ${minItemWidth}px)\` : \`${minItemWidth}px\`}, 1fr))`.
- Renders `<div data-slot="grid" className={cn('grid', GAP[gap], className)} style={{ gridTemplateColumns }} {...props} />`.

---

### Task 1: Build the `Grid` primitive + gallery (TDD)

**Files:**
- Create: `frontend/src/components/ui/grid.tsx`
- Create: `frontend/src/components/ui/grid.test.tsx`
- Modify: `frontend/src/pages/settings/sections/DesignSystemSection.tsx` (add a Grid demo group)

- [ ] **Step 1: Write the failing test**

Create `frontend/src/components/ui/grid.test.tsx`:
```tsx
import React from 'react'
import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import { Grid } from './grid'

describe('Grid', () => {
  it('emits an auto-fit minmax template with a responsive floor by default', () => {
    const { container } = render(<Grid minItemWidth={180}><div /></Grid>)
    const el = container.querySelector('[data-slot="grid"]') as HTMLElement
    expect(el).toBeTruthy()
    expect(el.className).toContain('grid')
    expect(el.className).toContain('gap-3') // md default
    expect(el.style.gridTemplateColumns).toBe('repeat(auto-fit, minmax(min(100%, 180px), 1fr))')
  })

  it('supports auto-fill and a bare (non-floored) min track', () => {
    const { container } = render(<Grid minItemWidth={320} fill responsiveFloor={false} gap="lg"><div /></Grid>)
    const el = container.querySelector('[data-slot="grid"]') as HTMLElement
    expect(el.className).toContain('gap-4')
    expect(el.style.gridTemplateColumns).toBe('repeat(auto-fill, minmax(320px, 1fr))')
  })

  it('merges a passed className', () => {
    const { container } = render(<Grid className="mb-4"><div /></Grid>)
    const el = container.querySelector('[data-slot="grid"]') as HTMLElement
    expect(el.className).toContain('mb-4')
    expect(el.className).toContain('grid')
  })
})
```

- [ ] **Step 2: Run it red**

Run: `yarn workspace frontend run test grid`
Expected: FAIL — cannot resolve `./grid`.

- [ ] **Step 3: Implement `frontend/src/components/ui/grid.tsx`**

```tsx
import * as React from 'react'
import { cn } from '@/lib/utils'

type GridProps = React.ComponentProps<'div'> & {
  minItemWidth?: number
  gap?: 'sm' | 'md' | 'lg'
  fill?: boolean
  responsiveFloor?: boolean
}

const GAP: Record<NonNullable<GridProps['gap']>, string> = {
  sm: 'gap-2',
  md: 'gap-3',
  lg: 'gap-4',
}

function Grid({
  minItemWidth = 180,
  gap = 'md',
  fill = false,
  responsiveFloor = true,
  className,
  style,
  ...props
}: GridProps) {
  const track = responsiveFloor ? `min(100%, ${minItemWidth}px)` : `${minItemWidth}px`
  const gridTemplateColumns = `repeat(${fill ? 'auto-fill' : 'auto-fit'}, minmax(${track}, 1fr))`
  return (
    <div
      data-slot="grid"
      className={cn('grid', GAP[gap], className)}
      style={{ gridTemplateColumns, ...style }}
      {...props}
    />
  )
}

export { Grid }
export type { GridProps }
```

- [ ] **Step 4: Run it green**

Run: `yarn workspace frontend run test grid`
Expected: PASS (3 tests).

- [ ] **Step 5: Add a Grid group to the gallery**

In `frontend/src/pages/settings/sections/DesignSystemSection.tsx`, import `Grid` and `StatCard`, and add a `<Group name="Grid">` (mirror the existing Group pattern) rendering a `<Grid minItemWidth={160} gap="md">` containing 3–4 `<StatCard>`s so the auto-fit behavior is visible. Keep the existing test assertions valid (the gallery test asserts specific group names + button variants — only ADD a group, don't rename existing ones).

- [ ] **Step 6: Verify gallery test + lint, commit**

Run `yarn workspace frontend run test DesignSystemSection` (green) and `yarn workspace frontend run lint` (clean). Then:
```bash
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH git commit -am "feat(ui): add Grid primitive (auto-fit responsive grid) + gallery"
```

---

### Task 2: Adopt `Grid` on the 3 swept pages

Replace the hand-rolled `grid-cols-[repeat(auto-fit|auto-fill,minmax(...))]` arbitrary-value classes (added during the page sweeps) with `<Grid>`. Look-preserving.

**Files:** Modify `frontend/src/pages/AccountsPage.tsx`, `frontend/src/pages/ReportsPage.tsx`, `frontend/src/pages/TransactionsPage.tsx`

**Interfaces:** Consumes `Grid` from `@/components/ui/grid`.

- [ ] **Step 1: Map each existing grid to Grid props (grep each page for `grid-cols-[repeat`)**

For each `<div className="… grid gap-N grid-cols-[repeat(<fit|fill>,minmax(<floor>,1fr))]">` found, replace the element with `<Grid minItemWidth={<N>} gap={<'md' if gap-3 / 'lg' if gap-4 / 'sm' if gap-2>} {fill if auto-fill} {responsiveFloor={false} ONLY if the original had a bare `minmax(Npx,1fr)` without `min(100%,…)`} className="<remaining classes e.g. mb-4>">`. Keep all children unchanged. Known sites:
  - AccountsPage stat grid: `repeat(auto-fit,minmax(180px,1fr))` `gap-3` `mb-4` → `<Grid minItemWidth={180} gap="md" responsiveFloor={false} className="mb-4">` (match the original floor form — verify by reading the current className).
  - ReportsPage stat grid: `minmax(180px,1fr)` `gap-3` `mb-4` → same shape as above.
  - ReportsPage `reportsGrid`: `minmax(min(100%,320px),1fr)` `gap-4` → `<Grid minItemWidth={320} gap="lg">` (responsiveFloor default true).
  - TransactionsPage stat grid: `minmax(160px,1fr)` `gap-3` `mb-4` → `<Grid minItemWidth={160} gap="md" responsiveFloor={false} className="mb-4">`.
  - TransactionsPage filter grid: `repeat(auto-fill,minmax(min(100%,180px),1fr))` `mb-3 gap-3` → `<Grid minItemWidth={180} fill gap="md" className="mb-3">`.
> For EACH site, read the CURRENT className in the file and reproduce its exact fit/fill, floor form, gap, and remaining utility classes — do not assume; the goal is byte-equivalent rendered `gridTemplateColumns` + gap + margins.

- [ ] **Step 2: Verify each page test stays green**

Run after the edits: `yarn workspace frontend run test AccountsPage`, `… ReportsPage`, `… TransactionsPage` — all green.

- [ ] **Step 3: Lint + commit**

`yarn workspace frontend run lint` clean. Then:
```bash
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH git commit -am "refactor(ui): adopt Grid primitive on Accounts/Reports/Transactions grids"
```

---

## Self-Review
- **Coverage:** Grid primitive built + tested + galleried (T1); adopted on the 3 swept pages' grids (T2). Broader adoption (the other ~8 grid sites on un-swept pages) follows as those pages are swept — out of scope here, noted. ✓
- **JIT constraint:** gap via lookup-table literals; minItemWidth via encapsulated inline gridTemplateColumns (the one allowed inline style, inside the primitive). ✓
- **Look-preservation:** adoption reproduces each site's exact fit/fill + floor form + gap + margins (read current className per site, don't assume). The only deliberate standardization risk is the responsiveFloor default — handled by matching each site's original floor form explicitly. ✓
- **Risk:** low — Grid is additive; adoption is class→component with identical rendered CSS, guarded by the three page tests.
