# Dashboard DS Polish — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the two business-vs-personal split blocks in `DashboardPage` (still on legacy `App.css` classes) with a Tailwind + DS-primitive `SplitPanel` component, and delete the unused legacy CSS. No data/behavior change.

**Architecture:** New `SplitPanel` component (Tailwind layout + DS `AmountText` for figures + a private `FocusCard` helper with the DS mockup's toned `color-mix` borders). `DashboardPage` keeps the two enclosing `BentoTile`s (icon/label/description) and passes the already-derived `bizSplit` values as props. Then the 11 `business*` legacy classes are removed from `App.css`.

**Tech Stack:** React 19, TypeScript, Tailwind v4, `@connor-adams/designsystem` (`AmountText`), vitest + @testing-library/react.

## Global Constraints

- Run from repo root. Yarn 4; every yarn command needs `export NODE_AUTH_TOKEN=$(gh auth token)` (the `.yarnrc.yml` GitHub Packages scope reads it). Prefix commits with `PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH` for husky.
- Commit author is Connor only — never add a `Co-Authored-By` trailer.
- Color = token utilities / token vars only (no hex). `color-mix` with a token may stay inline (Tailwind can't express it), mirroring the existing budget pills.
- Tests are colocated; test files `import React from 'react'` (repo convention).
- Single frontend test: `yarn workspace frontend run test <NameFragment>`. Lint: `yarn workspace frontend run lint`.

---

### Task 1: `SplitPanel` component (TDD)

**Files:**
- Create: `frontend/src/components/dashboard/SplitPanel.tsx`
- Create: `frontend/src/components/dashboard/SplitPanel.test.tsx`

**Interfaces:**
- Produces: `export function SplitPanel(props: { business: number; personal: number; businessShare: number; currency: string; emptyCaption: string })` — Task 2 renders it inside the two business/personal `BentoTile`s.
- Consumes: `AmountText` from `@connor-adams/designsystem`.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/components/dashboard/SplitPanel.test.tsx`:
```tsx
import React from 'react'
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { SplitPanel } from './SplitPanel'

describe('SplitPanel', () => {
  it('renders both toned figures and the share labels', () => {
    render(
      <SplitPanel business={3740} personal={6100} businessShare={38} currency="CAD" emptyCaption="No income in current filters." />,
    )
    expect(screen.getByText('Business')).toBeInTheDocument()
    expect(screen.getByText('Personal')).toBeInTheDocument()
    expect(screen.getByText(/Business 38%/)).toBeInTheDocument()
    expect(screen.getByText(/Personal 62%/)).toBeInTheDocument()
  })

  it('shows the empty caption when business + personal <= 0', () => {
    render(
      <SplitPanel business={0} personal={0} businessShare={0} currency="CAD" emptyCaption="No income in current filters." />,
    )
    expect(screen.getByText('No income in current filters.')).toBeInTheDocument()
  })

  it('hides the empty caption when there is value', () => {
    render(
      <SplitPanel business={100} personal={0} businessShare={100} currency="CAD" emptyCaption="No income in current filters." />,
    )
    expect(screen.queryByText('No income in current filters.')).not.toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `export NODE_AUTH_TOKEN=$(gh auth token); yarn workspace frontend run test SplitPanel`
Expected: FAIL — cannot resolve `./SplitPanel`.

- [ ] **Step 3: Implement the component**

Create `frontend/src/components/dashboard/SplitPanel.tsx`:
```tsx
import * as React from 'react'
import { AmountText } from '@connor-adams/designsystem'

type Tone = 'business' | 'personal'

const TONE_COLOR: Record<Tone, string> = {
  business: 'var(--chart-business)',
  personal: 'var(--positive)',
}

function FocusCard({
  label,
  value,
  tone,
  currency,
}: {
  label: string
  value: number
  tone: Tone
  currency: string
}) {
  const color = TONE_COLOR[tone]
  return (
    <div
      className="rounded-lg p-3.5"
      style={{
        border: `1px solid color-mix(in srgb, ${color} 44%, var(--border))`,
        boxShadow: `inset 0 0 0 1px color-mix(in oklch, ${color} 18%, transparent)`,
        background: 'color-mix(in oklch, var(--background) 60%, transparent)',
      }}
    >
      <p className="m-0 text-xs font-bold uppercase tracking-wide text-[var(--muted-foreground)]">{label}</p>
      <p className="m-0 mt-1 text-2xl font-bold tabular-nums tracking-tight text-[var(--foreground)]">
        <AmountText value={value} currency={currency || undefined} colored={false} decimals={0} />
      </p>
    </div>
  )
}

type SplitPanelProps = {
  business: number
  personal: number
  businessShare: number
  currency: string
  emptyCaption: string
}

export function SplitPanel({ business, personal, businessShare, currency, emptyCaption }: SplitPanelProps) {
  const personalShare = 100 - businessShare
  const isEmpty = business + personal <= 0
  return (
    <div data-slot="split-panel" className="flex h-full flex-col">
      <div className="grid grid-cols-2 gap-3.5">
        <FocusCard label="Business" value={business} tone="business" currency={currency} />
        <FocusCard label="Personal" value={personal} tone="personal" currency={currency} />
      </div>
      <div className="mt-4">
        <div className="mb-2 flex justify-between text-sm font-semibold text-[var(--foreground)]" aria-hidden="true">
          <span>Business {businessShare.toFixed(0)}%</span>
          <span>Personal {personalShare.toFixed(0)}%</span>
        </div>
        <div
          className="flex h-3.5 overflow-hidden rounded-md border border-[var(--border)]"
          role="img"
          aria-label={`Business ${businessShare.toFixed(0)} percent, personal ${personalShare.toFixed(0)} percent`}
        >
          <span style={{ width: `${businessShare}%`, background: 'var(--chart-business)' }} />
          <span style={{ width: `${personalShare}%`, background: 'var(--positive)' }} />
        </div>
        {isEmpty ? (
          <p className="mt-2 mb-0 text-sm leading-6 text-muted-foreground">{emptyCaption}</p>
        ) : null}
      </div>
    </div>
  )
}
```
> If `AmountText` rejects `currency={undefined}` at the type level, change the prop to `currency={currency || ''}` and confirm it still renders a number — but `undefined` matches its optional `currency?: string`.

- [ ] **Step 4: Run the test, verify it passes**

Run: `export NODE_AUTH_TOKEN=$(gh auth token); yarn workspace frontend run test SplitPanel`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
export NODE_AUTH_TOKEN=$(gh auth token)
git add frontend/src/components/dashboard/SplitPanel.tsx frontend/src/components/dashboard/SplitPanel.test.tsx
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH git commit -m "feat(dashboard): SplitPanel component (Tailwind + DS AmountText)"
```

---

### Task 2: Wire `SplitPanel` into `DashboardPage` and delete legacy CSS

**Files:**
- Modify: `frontend/src/pages/DashboardPage.tsx` (the two business/personal blocks, ~lines 1083–1177; add the import)
- Modify: `frontend/src/App.css` (delete the 11 `business*` classes, ~lines 858–918)

**Interfaces:**
- Consumes: `SplitPanel` (Task 1); existing `bizSplit` memo (`{ income:{business,personal}, spend:{business,personal}, incomeShare, spendShare }`) and `displayCurrency`.

- [ ] **Step 1: Add the import**

In `DashboardPage.tsx`, beside the other `@/components/dashboard/*` imports:
```tsx
import { SplitPanel } from '@/components/dashboard/SplitPanel'
```

- [ ] **Step 2: Replace the income block**

Replace the income `BentoTile`'s body (the `businessSpotlightGrid` + `businessSharePanel` markup inside the `Income · business vs personal` tile) with a single child, keeping the `<BentoTile span={6} rows={2} aria-busy={loading} icon={<Wallet className="size-5" />} label="Income · business vs personal" description="Earned income split by business vs personal.">` wrapper unchanged:
```tsx
<SplitPanel
  business={bizSplit.income.business}
  personal={bizSplit.income.personal}
  businessShare={bizSplit.incomeShare}
  currency={displayCurrency}
  emptyCaption="No income in current filters."
/>
```

- [ ] **Step 3: Replace the spend block**

Same for the `Spend · business vs personal` tile (keep its `icon={<ShoppingBag className="size-5" />}`, label, and `description="Spend (gross outflows net of refunds) split by business vs personal."`):
```tsx
<SplitPanel
  business={bizSplit.spend.business}
  personal={bizSplit.spend.personal}
  businessShare={bizSplit.spendShare}
  currency={displayCurrency}
  emptyCaption="No net spend in current filters."
/>
```

- [ ] **Step 4: Remove now-dead icon imports if unused**

`Wallet` / `ShoppingBag` (from `lucide-react`) are still used by the `BentoTile` `icon` props — keep them. Do NOT remove. (Sanity: `grep -n "Wallet\|ShoppingBag" frontend/src/pages/DashboardPage.tsx` still shows the icon usages.)

- [ ] **Step 5: Delete the legacy App.css classes**

In `frontend/src/App.css`, delete the block defining these 11 classes (contiguous, ~lines 858–918): `.businessSpotlightGrid`, `.businessFocusCard`, `.businessFocusCard--business`, `.businessFocusCard--personal`, `.businessSharePanel`, `.businessShareLabels`, `.businessShareBar`, `.businessShareFill`, `.businessShareFill--business`, `.businessShareFill--personal`, `.businessShareCaption`.

- [ ] **Step 6: Verify nothing else references them**

Run:
```bash
grep -rn "businessFocusCard\|businessShare\|businessSpotlight" frontend/src
```
Expected: **no matches** (both the markup and the CSS are gone).

- [ ] **Step 7: Full gates**

```bash
export NODE_AUTH_TOKEN=$(gh auth token)
yarn workspace frontend run lint
yarn workspace frontend run test DashboardPage
yarn workspace frontend run test SplitPanel
```
Expected: lint clean; both test files green (DashboardPage characterization still passes — the tile labels/structure are unchanged).

- [ ] **Step 8: Commit**

```bash
export NODE_AUTH_TOKEN=$(gh auth token)
git add frontend/src/pages/DashboardPage.tsx frontend/src/App.css
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH git commit -m "refactor(dashboard): business/personal split uses SplitPanel; drop legacy App.css"
```

---

## Self-Review

- **Spec coverage:** SplitPanel (Tailwind + AmountText + toned FocusCard) → Task 1; replace both blocks + delete legacy CSS → Task 2. ✓
- **Placeholder scan:** all steps carry real code/commands; the one `> if AmountText rejects undefined` note is a typed fallback, not a TODO. ✓
- **Type consistency:** `SplitPanel` prop names (`business`/`personal`/`businessShare`/`currency`/`emptyCaption`) match between Task 1 definition and Task 2 call sites; `bizSplit.{income,spend}.{business,personal}` + `bizSplit.{income,spend}Share` match the researched `BusinessIncomeSpend` shape. ✓
- **No feature loss:** figures, shares, the proportion bar, the empty captions, and the enclosing tiles all preserved; only the styling mechanism changes (legacy CSS → Tailwind/DS). ✓
