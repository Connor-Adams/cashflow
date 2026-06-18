# Extract FilterCard Primitive Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]` checkboxes.

**Goal:** Extract the divergent "FilterBar wrapped in a Card" pattern (5 pages, built 5 different ways) into a `FilterCard` primitive with a `density` variant, show it in the gallery, and adopt it on 4 pages. Unlike Grid/SectionHeader, adoption STANDARDIZES (not byte-equivalent) — that is the point (Connor chose the variant approach).

**Architecture:** `FilterCard` in `frontend/src/components/ui/filter-card.tsx` is a thin preset over the `Card` primitive: it renders `<Card>` with `mb-4` + density-dependent padding/width, wrapping its children (the page's `<FilterBar>`). `cn` uses `tailwind-merge`, so the compact density's `p-2 sm:p-3` cleanly overrides Card's default `p-4 sm:p-5`.

**Tech Stack:** React 19, Tailwind v4, vitest. Reference: `frontend/src/components/ui/card.tsx`, `stat-card.tsx` (a sibling Card preset).

## Global Constraints
- Run from repo root: `/Users/connoradams/Developer/cashflow/.claude/worktrees/extract-filter-card` (node_modules symlinked — `yarn workspace frontend run test` works).
- Commit husky workaround, exact prefix: `PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH git commit -m "…"` (if `-m` blocked, `git commit --file=<tmpfile>`). Sole author — NEVER add Co-Authored-By.
- Token-only color; no hex; no inline style.

## Scope decisions (settled with Connor)
- `density` variant: `compact` (Dashboard's `w-fit max-w-full p-2 sm:p-3`) and `comfortable` (full-width, Card default padding). Default `comfortable`.
- Adopt on **DashboardPage (compact), ReportsPage, PartnerFairnessPage, RecurringPage** (comfortable). Compact preserves Dashboard's hand-tuned look.
- **Leave SankeyPage alone** — its FilterBar is bare (no card); adding one is a separate layout decision.
- Do NOT touch AccountsPage/TransactionsPage (no filter cards there; also in-flight on another open PR).

## FilterCard API (build exactly this)
```tsx
type FilterCardProps = React.ComponentProps<typeof Card> & {
  density?: 'compact' | 'comfortable'
}
```
- `DENSITY` lookup (JIT-safe literals): `{ compact: 'w-fit max-w-full p-2 sm:p-3', comfortable: '' }` (comfortable → Card's default `p-4 sm:p-5` stands).
- Renders `<Card data-slot="filter-card" className={cn('mb-4', DENSITY[density], className)} {...props}>` (children pass through; FilterBar goes directly inside — NO nested CardContent).

---

### Task 1: Build the `FilterCard` primitive + gallery (TDD)

**Files:**
- Create: `frontend/src/components/ui/filter-card.tsx`
- Create: `frontend/src/components/ui/filter-card.test.tsx`
- Modify: `frontend/src/pages/settings/sections/DesignSystemSection.tsx` (add a FilterCard demo group)

- [ ] **Step 1: Write the failing test**

Create `frontend/src/components/ui/filter-card.test.tsx`:
```tsx
import React from 'react'
import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import { FilterCard } from './filter-card'

describe('FilterCard', () => {
  it('defaults to comfortable (full-width, no compact classes) with mb-4', () => {
    const { container } = render(<FilterCard><div>filters</div></FilterCard>)
    const el = container.querySelector('[data-slot="filter-card"]') as HTMLElement
    expect(el).toBeTruthy()
    expect(el.className).toContain('mb-4')
    expect(el.className).not.toContain('w-fit')
  })

  it('compact density adds w-fit and tight padding (overriding Card default)', () => {
    const { container } = render(<FilterCard density="compact"><div>filters</div></FilterCard>)
    const el = container.querySelector('[data-slot="filter-card"]') as HTMLElement
    expect(el.className).toContain('w-fit')
    expect(el.className).toContain('p-2')
    expect(el.className).not.toContain('p-4') // twMerge dropped Card's p-4
  })

  it('renders children and merges className', () => {
    const { container, getByText } = render(<FilterCard className="mt-2"><div>filters</div></FilterCard>)
    expect(getByText('filters')).toBeInTheDocument()
    expect((container.querySelector('[data-slot="filter-card"]') as HTMLElement).className).toContain('mt-2')
  })
})
```

- [ ] **Step 2: Run it red** — `yarn workspace frontend run test filter-card` → FAIL (cannot resolve `./filter-card`).

- [ ] **Step 3: Implement `frontend/src/components/ui/filter-card.tsx`**

```tsx
import * as React from 'react'
import { cn } from '@/lib/utils'
import { Card } from './card'

type FilterCardProps = React.ComponentProps<typeof Card> & {
  density?: 'compact' | 'comfortable'
}

const DENSITY: Record<NonNullable<FilterCardProps['density']>, string> = {
  compact: 'w-fit max-w-full p-2 sm:p-3',
  comfortable: '',
}

function FilterCard({ density = 'comfortable', className, ...props }: FilterCardProps) {
  return <Card data-slot="filter-card" className={cn('mb-4', DENSITY[density], className)} {...props} />
}

export { FilterCard }
export type { FilterCardProps }
```

- [ ] **Step 4: Run it green** — `yarn workspace frontend run test filter-card` → PASS (3 tests). (If the compact test's `not.toContain('p-4')` fails, confirm `cn` is `twMerge`-based — it is, per `lib/utils.ts` — and that `p-2 sm:p-3` follows the Card base in the merged string.)

- [ ] **Step 5: Add a FilterCard group to the gallery**

In `frontend/src/pages/settings/sections/DesignSystemSection.tsx`, import `FilterCard` and add a `<Group name="Filter card">` showing both densities, e.g. a `<FilterCard className="w-full"><div className="text-sm text-muted-foreground">Comfortable filter bar</div></FilterCard>` and a `<FilterCard density="compact"><div className="text-sm text-muted-foreground">Compact</div></FilterCard>`. Do NOT rename existing groups (gallery test asserts them).

- [ ] **Step 6: Verify gallery + lint, commit**

`yarn workspace frontend run test DesignSystemSection` green; `yarn workspace frontend run lint` clean. Then:
```bash
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH git commit -am "feat(ui): add FilterCard primitive (Card preset for filter bars) + gallery"
```

---

### Task 2: Adopt `FilterCard` on 4 pages

**Files:** Modify `frontend/src/pages/DashboardPage.tsx`, `frontend/src/pages/ReportsPage.tsx`, `frontend/src/pages/PartnerFairnessPage.tsx`, `frontend/src/pages/RecurringPage.tsx`

**Interfaces:** Consumes `FilterCard` from `@/components/ui/filter-card`.

- [ ] **Step 1: Adopt per page (import FilterCard in each)**

- **DashboardPage** (~736): `<Card className="dashboardFilters mt-2 mb-4 w-fit max-w-full p-2 sm:p-3"><CardContent className="p-0"><FilterBar …/></CardContent></Card>` → `<FilterCard density="compact" className="mt-2"><FilterBar …/></FilterCard>`. First grep `frontend/src/App.css` for `.dashboardFilters` — if it carries real styling beyond a marker, preserve it via className; if it's unused/empty, drop it. Drop the now-unneeded `<CardContent p-0>` (FilterCard's Card pads directly via the compact density). Keep the `<FilterBar>` and all its props unchanged.
- **ReportsPage** (~512): `<Card className="mb-4"><FilterBar …/></Card>` → `<FilterCard><FilterBar …/></FilterCard>` (comfortable default = mb-4 + Card padding — byte-equivalent).
- **PartnerFairnessPage** (~187): `<Card className="mb-4"><CardContent className="pt-6"><FilterBar …/></CardContent></Card>` → `<FilterCard><FilterBar …/></FilterCard>` (drops the `pt-6` in favor of standard padding — an intended standardization; note it in the report).
- **RecurringPage** (~82): `<section className="card"><FilterBar …/></section>` → `<FilterCard><FilterBar …/></FilterCard>` (replaces the raw `.card` legacy class with the primitive; grep App.css `.card` to confirm it ≈ Card default).

For each: locate by the current markup, replace the wrapper, keep `<FilterBar>` + children verbatim, update closing tags, remove now-unused `Card`/`CardContent` imports ONLY if no longer used elsewhere in that file (check first).

- [ ] **Step 2: Verify**

Run for any page with a test: `yarn workspace frontend run test DashboardPage PartnerFairnessPage` (these have tests; Reports/Recurring may not — run what exists). Then a broad check: `yarn workspace frontend run test --run` should stay green.
Confirm no leftover raw filter wrappers: `grep -rn 'dashboardFilters\|reportsFilters' frontend/src/pages` (Dashboard's should be gone; reportsFilters may already be absent).

- [ ] **Step 3: Lint + commit**

`yarn workspace frontend run lint` clean. Then:
```bash
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH git commit -am "refactor(ui): adopt FilterCard on Dashboard/Reports/PartnerFairness/Recurring"
```

---

## Self-Review
- **Coverage:** FilterCard built + tested + galleried (T1); adopted on 4 of the 5 filter-bar pages (T2). Sankey (bare) deliberately excluded; Accounts/Transactions have no filter card. ✓
- **Standardization (not byte-equivalent):** Dashboard preserved via `compact`; Reports byte-equivalent (comfortable = its current `Card mb-4`); PartnerFairness loses `pt-6` (intended); Recurring swaps raw `.card` for the primitive. All deliberate, noted. ✓
- **twMerge dependency:** compact `p-2 sm:p-3` overriding Card's `p-4 sm:p-5` relies on `cn`=twMerge (verified in `lib/utils.ts`). The test asserts `not.toContain('p-4')` to lock it. ✓
- **Conflict avoidance:** touches Dashboard/Reports/PartnerFairness/Recurring — none overlap the open #680 (Accounts/Transactions). ✓
- **Risk:** low — additive primitive; adoption is a thin Card-preset swap with deliberate, documented standardizations; broad test run guards.
