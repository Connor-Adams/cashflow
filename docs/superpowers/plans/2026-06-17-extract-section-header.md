# Extract SectionHeader Primitive Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]` checkboxes.

**Goal:** Extract the app's second most-repeated pattern — the card/section header (title + description + right-side actions), hand-rolled 62× across 44 files as `transactionsPanelHeader`/`accountsCardHeader`/`rulesCardHeader`/`reportsCardHeader` (61 of 62 share one layout) — into a shared `SectionHeader` primitive, sibling to the existing page-level `PageHeader`. Build it, show it in the gallery, adopt on the 3 already-swept pages.

**Architecture:** `SectionHeader` in `frontend/src/components/ui/section-header.tsx`. Mirrors `PageHeader`'s API and JSX exactly, but card-level: `<h2>` instead of `<h1>`, self-contained typography (no dependence on the ambient `.page h2` cascade), token-utility classes throughout.

**Tech Stack:** React 19, Tailwind v4, vitest. Reference: `frontend/src/components/ui/page-header.tsx` (the sibling to copy the shape from).

## Global Constraints
- Run from repo root: `/Users/connoradams/Developer/cashflow/.claude/worktrees/extract-section-header` (node_modules symlinked — `yarn workspace frontend run test` works).
- Commit husky workaround, exact prefix: `PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH git commit -m "…"` (if `-m` blocked, `git commit --file=<tmpfile>`). Sole author — NEVER add Co-Authored-By.
- Token-only color; no hex; no inline `style`.
- Adoption must be look-preserving against the current `*CardHeader`/`*PanelHeader` rendering.

## Scope decisions (settled)
- **Default layout only** (covers 59/62). Do NOT add a `variant` prop. Leave the 3 `aiVisibilityHeader` (`<strong>` + `items-baseline`) bespoke — out of scope.
- Do NOT touch `CollapsibleCard`'s internal header (it's the click-trigger + chevron with event delegation).
- `PageHeader` stays page-level (h1) and unchanged; `SectionHeader` is the card-level (h2) sibling.

## SectionHeader API (build exactly this — mirrors PageHeader)
```tsx
type SectionHeaderProps = React.ComponentProps<'div'> & {
  title: React.ReactNode
  description?: React.ReactNode
  actions?: React.ReactNode
}
```
Renders:
```tsx
<div data-slot="section-header" className={cn('mb-4 flex flex-wrap items-start justify-between gap-3', className)} {...props}>
  <div className="min-w-0">
    <h2 className="mb-1 mt-0 text-[1.05rem] font-semibold tracking-tight">{title}</h2>
    {description ? <p className="mb-0 text-sm leading-6 text-muted-foreground">{description}</p> : null}
    {children}
  </div>
  {actions ? <div className="flex shrink-0 flex-wrap gap-2">{actions}</div> : null}
</div>
```
(The h2 typography `text-[1.05rem] font-semibold tracking-tight` reproduces the effective `.page h2` style; `mb-1 mt-0` reproduces the `*CardHeader h2` override.)

---

### Task 1: Build the `SectionHeader` primitive + gallery (TDD)

**Files:**
- Create: `frontend/src/components/ui/section-header.tsx`
- Create: `frontend/src/components/ui/section-header.test.tsx`
- Modify: `frontend/src/pages/settings/sections/DesignSystemSection.tsx` (add a SectionHeader demo group)

- [ ] **Step 1: Write the failing test**

Create `frontend/src/components/ui/section-header.test.tsx`:
```tsx
import React from 'react'
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { SectionHeader } from './section-header'

describe('SectionHeader', () => {
  it('renders the title as an h2', () => {
    render(<SectionHeader title="Accounts" />)
    const h = screen.getByRole('heading', { name: 'Accounts', level: 2 })
    expect(h).toBeInTheDocument()
  })

  it('renders description and actions when provided', () => {
    render(
      <SectionHeader
        title="Budgets"
        description="Spend vs target"
        actions={<button>Add</button>}
      />,
    )
    expect(screen.getByText('Spend vs target')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Add' })).toBeInTheDocument()
  })

  it('omits description and actions wrappers when absent', () => {
    const { container } = render(<SectionHeader title="Bare" />)
    expect(container.querySelector('[data-slot="section-header"]')).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('merges a passed className', () => {
    const { container } = render(<SectionHeader title="X" className="mb-0" />)
    const el = container.querySelector('[data-slot="section-header"]') as HTMLElement
    expect(el.className).toContain('mb-0')
    expect(el.className).toContain('justify-between')
  })
})
```

- [ ] **Step 2: Run it red** — `yarn workspace frontend run test section-header` → FAIL (cannot resolve `./section-header`).

- [ ] **Step 3: Implement `frontend/src/components/ui/section-header.tsx`**

```tsx
import * as React from 'react'
import { cn } from '@/lib/utils'

type SectionHeaderProps = React.ComponentProps<'div'> & {
  title: React.ReactNode
  description?: React.ReactNode
  actions?: React.ReactNode
}

function SectionHeader({ title, description, actions, className, children, ...props }: SectionHeaderProps) {
  return (
    <div
      data-slot="section-header"
      className={cn('mb-4 flex flex-wrap items-start justify-between gap-3', className)}
      {...props}
    >
      <div className="min-w-0">
        <h2 className="mb-1 mt-0 text-[1.05rem] font-semibold tracking-tight">{title}</h2>
        {description ? (
          <p className="mb-0 text-sm leading-6 text-muted-foreground">{description}</p>
        ) : null}
        {children}
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap gap-2">{actions}</div> : null}
    </div>
  )
}

export { SectionHeader }
export type { SectionHeaderProps }
```

- [ ] **Step 4: Run it green** — `yarn workspace frontend run test section-header` → PASS (4 tests).

- [ ] **Step 5: Add a SectionHeader group to the gallery**

In `frontend/src/pages/settings/sections/DesignSystemSection.tsx`, import `SectionHeader` and add a `<Group name="Section header">` rendering a `<SectionHeader title="Section title" description="Supporting description" actions={<Button variant="secondary">Action</Button>} />`. Do NOT rename existing groups (the gallery test asserts the existing names). Adding "Section header" is additive-safe.

- [ ] **Step 6: Verify gallery + lint, commit**

`yarn workspace frontend run test DesignSystemSection` green; `yarn workspace frontend run lint` clean. Then:
```bash
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH git commit -am "feat(ui): add SectionHeader primitive (card-level header) + gallery"
```

---

### Task 2: Adopt `SectionHeader` on the 3 swept pages

Replace the default-layout `*CardHeader`/`*PanelHeader` raw-class headers on Accounts/Reports/Transactions with `<SectionHeader>`. Look-preserving.

**Files:** Modify `frontend/src/pages/AccountsPage.tsx`, `frontend/src/pages/ReportsPage.tsx`, `frontend/src/pages/TransactionsPage.tsx`

**Interfaces:** Consumes `SectionHeader` from `@/components/ui/section-header`.

- [ ] **Step 1: Find the default-layout headers on the 3 pages**

Grep each page for `className="[^"]*(accountsCardHeader|reportsCardHeader|reportsPanelHeader|transactionsPanelHeader)`. Each is a `<div className="…Header"><div><h2>{title}</h2><p className="…muted…">{desc}</p></div>{right-side}</div>` shape. SKIP any `aiVisibilityHeader` (bespoke, out of scope) and SKIP headers that are a `CollapsibleCard` trigger.

- [ ] **Step 2: Convert each to `<SectionHeader>`**

For each found header:
- `title` ← the `<h2>` content (verbatim expression).
- `description` ← the `<p className="…muted…">` content (verbatim), if present.
- `actions` ← whatever was on the right side (badges, `<select>`, buttons, links) — pass as the `actions` prop verbatim.
- Drop the raw header class. If the header had an extra utility (e.g. a different margin), pass it via `className` on `<SectionHeader>`.
Replace the whole header `<div>…</div>` with `<SectionHeader title={…} description={…} actions={…} />`. Keep the rest of the card body unchanged.
> Read each header's exact markup; reproduce title/description/actions faithfully. Do not change card bodies or any non-header markup.

- [ ] **Step 3: Verify each page test green**

`yarn workspace frontend run test AccountsPage`, `… ReportsPage`, `… TransactionsPage` — all green.

- [ ] **Step 4: Lint + commit**

`yarn workspace frontend run lint` clean. Then:
```bash
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH git commit -am "refactor(ui): adopt SectionHeader on Accounts/Reports/Transactions card headers"
```

---

## Self-Review
- **Coverage:** SectionHeader built + tested + galleried (T1); adopted on the 3 swept pages' default-layout headers (T2). Broader adoption (the ~40 other files) follows as pages are swept — out of scope here, noted. ✓
- **Scope discipline:** aiVisibilityHeader (3, bespoke) and CollapsibleCard trigger explicitly excluded. ✓
- **Look-preservation:** SectionHeader reproduces the dominant `*CardHeader` layout + h2 typography + muted description exactly; adoption maps title/description/actions verbatim per site. ✓
- **Risk:** low — additive primitive; adoption is structural class→component with the same rendered layout, guarded by the three page tests. The one judgment per site is what counts as `actions` (everything not title/description) — explicit in Step 2.
