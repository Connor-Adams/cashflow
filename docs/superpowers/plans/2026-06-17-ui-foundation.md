# UI Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish an objective, verifiable UI standard — audit doc, rules doc, a live component gallery, and one fully-migrated pilot page (AccountsPage) — so later page-sweeps are fast and not a matter of taste.

**Architecture:** Pure frontend. No backend/API changes. The gallery is a new in-app Settings section rendering existing `ui/` primitives in every variant/state, read live against the active theme. The pilot swaps AccountsPage's raw App.css classes + inline styles for existing primitives + Tailwind token utilities — no behavior change, guarded by a new characterization test.

**Tech Stack:** Vite + React 19, Tailwind v4 (token utilities), react-router-dom v7, vitest + @testing-library/react. Primitives in `frontend/src/components/ui/`.

## Global Constraints

- Run everything from the **repo root**: `/Users/connoradams/Developer/cashflow/.claude/worktrees/suspicious-greider-5951c5`. Yarn-1 workspaces hoist to root.
- **Commits fail under husky** unless `node_modules/.bin` is on PATH. Prefix every commit: `PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH git commit -m "…"`. Connor is sole author — **never** add a `Co-Authored-By` trailer.
- **Color = tokens only.** No hex literals, no raw `.muted`/`.statValue`/etc. App.css classes in new/migrated code. Use Tailwind token utilities (`text-muted-foreground`, `bg-card`, `border-border`, …) or existing primitives.
- Single frontend test file: `yarn workspace frontend run test <NameFragment>`. Filter by name: `… run test -- -t '<regex>'`. Lint: `yarn workspace frontend run lint`.
- Prefer Tailwind utilities over raw CSS (project rule). Lookup tables for variant→class maps (JIT needs literal class strings).
- This plan does NOT refactor primitive APIs and does NOT dismantle App.css beyond the slice the pilot touches. Those are named later sub-projects.

---

### Task 1: Primitive audit (read-only doc)

Produces the inventory that grounds the rules and the backlog. No source changes.

**Files:**
- Create: `docs/superpowers/specs/2026-06-17-ui-primitive-audit.md`

**Interfaces:**
- Produces: the canonical list of "blessed" primitives Task 2 (rules) and Task 3 (gallery) reference.

- [ ] **Step 1: Gather consumer counts**

Run from repo root:
```bash
cd frontend/src
for f in components/ui/*.tsx; do
  [ "${f%.test.tsx}" != "$f" ] && continue   # skip tests
  base=$(basename "$f" .tsx)
  # count files importing this primitive by path
  n=$(grep -rl "components/ui/$base'" --include=*.tsx . | grep -v "$f" | wc -l | tr -d ' ')
  echo "$base : $n consumers"
done | sort -t: -k2 -rn
```
Record the output — it's the consumer column.

- [ ] **Step 2: Write the audit doc**

Create `docs/superpowers/specs/2026-06-17-ui-primitive-audit.md` with:
1. A table: `primitive | consumers | variants/props | status (solid / inconsistent / gap)`.
2. A **"Known internal leaks"** section capturing these confirmed findings (do not fix here — log for the later hardening sub-project):
   - `stat-card.tsx:33-38` — `StatCard` renders raw `.statLabel` / `.statValue` / `.statHint` / `.muted` App.css classes.
   - `empty-state.tsx:17-18` — `EmptyState` renders raw `.emptyState` / `.muted`.
   - `metric-stat.tsx:23,43` — references **undefined** token `--accent-positive` (only `--accent-warm`/`--accent-green` exist in `index.css:162-163`) → dead color; also inline `style={{ borderLeft }}`.
   - `card.tsx:9,49` — `Card` (`p-4 sm:p-5`) + `CardContent` (`px-5 py-5`) double-pad when composed.
3. A **"Gaps"** section naming primitives the rules will need but that don't exist yet: page-level content `Section` wrapper, a blessed stat-grid layout, canonical loading-row usage.

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/specs/2026-06-17-ui-primitive-audit.md
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH git commit -m "docs(ui): primitive audit — inventory, consumer counts, internal leaks"
```

---

### Task 2: Rules doc

The codified, concrete standard. Pulls real values from the Dashboard's good usage and the audit.

**Files:**
- Create: `docs/ui-rules.md`

**Interfaces:**
- Consumes: Task 1 blessed-primitive list.
- Produces: the rules the gallery demonstrates and the pilot is checked against. Referenced by `CLAUDE.md` readers and later sweeps.

- [ ] **Step 1: Write the rules doc**

Create `docs/ui-rules.md` with these sections, each stating exact values (no "appropriate"/"sensible"):

```markdown
# Cashflow UI Rules

North-star: the Dashboard's *look*. Implementation target: the `components/ui/` primitives.
"Match the Dashboard" means match its polish — NOT copy its raw-CSS/inline-style internals.

## Spacing
- Page content vertical rhythm: `space-y-4` between major blocks (matches Dashboard `gap-4`).
- Grid gaps: `gap-3` (dense forms/stat grids), `gap-4` (tile/section grids).
- Section top spacing after header: header owns `mb-4` (see `PageHeader`). No ad-hoc `mt-*` on the first block.
- NO inline `margin`/`padding` via `style={{}}`. Use utilities.

## Page anatomy (one blessed structure)
1. `<div className="page">` wrapper (keep; it is layout-neutral).
2. `<PageHeader title description actions />` — the only page title source.
3. Optional toolbar/filter row (Card-wrapped FilterBar like Dashboard, or a `flex flex-wrap gap-2` action row).
4. Content blocks separated by `space-y-4`.

## Typography
- Page title: `PageHeader` h1 (do not hand-roll `<h1>`).
- Section label: `text-sm font-medium text-muted-foreground`.
- Body: default; muted/help text: `text-sm text-muted-foreground` (NOT the `.muted` class in new code).
- Numeric stat value: use `StatCard` (`value` prop); don't hand-roll `.statValue`.

## Density (tables)
- Use the `Table`/`TableHeader`/`TableRow`/`TableHead`/`TableCell` primitives. They already set row borders, `px-3`, header casing, hover. Do NOT add a `.table` class or a `.tableWrap` wrapper — `Table` self-wraps in an overflow container.
- For dashboard-style compact summary tables, use `TableTile`.

## States (exactly one way each)
- Empty (in a table): `<EmptyTableRow colSpan title description />`.
- Empty (standalone block): `<EmptyState title description actions />`.
- Loading (table rows): existing `SkeletonRow`.
- Error banner: `<Alert variant="error">message</Alert>` (replaces the `.error` class).

## Color
- Tokens only via Tailwind utilities: `text-foreground`, `text-muted-foreground`, `bg-card`, `bg-muted`, `border-border`, `text-danger`, etc.
- No hex. No `var(--…)` in inline styles for new code (primitives may, until hardened).

## Stat grid (blessed layout)
- A responsive stat row: `<div className="grid gap-3 grid-cols-[repeat(auto-fit,minmax(180px,1fr))]">` containing `<StatCard>`s. (Replaces `.accountsStats` + `.statCard`.)
```

- [ ] **Step 2: Commit**

```bash
git add docs/ui-rules.md
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH git commit -m "docs(ui): UI rules — spacing, page anatomy, typography, density, states, color"
```

---

### Task 3: Design System gallery section

A new in-app Settings section rendering the blessed primitives in every variant/state, live against the active theme.

**Files:**
- Create: `frontend/src/pages/settings/sections/DesignSystemSection.tsx`
- Create: `frontend/src/pages/settings/sections/DesignSystemSection.test.tsx`
- Modify: `frontend/src/App.tsx` (import at ~line 49; route at ~line 176)
- Modify: `frontend/src/pages/settings/SettingsTabLayout.tsx:5-10` (SUB_NAV entry)
- Modify: `frontend/src/pages/settings/useActiveSettingsTopTab.ts` (match + branch)

**Interfaces:**
- Consumes: existing primitives `Button`, `Card`, `StatCard`, `Badge`, `Alert`, `Input`, `Label`, `EmptyState`.
- Produces: route `/settings/design-system` rendering `<DesignSystemSection />`.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/pages/settings/sections/DesignSystemSection.test.tsx`:
```tsx
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { DesignSystemSection } from './DesignSystemSection'

describe('DesignSystemSection', () => {
  it('renders a section heading for each primitive group', () => {
    render(<DesignSystemSection />)
    for (const group of ['Buttons', 'Cards & stats', 'Badges', 'Alerts', 'Inputs', 'States']) {
      expect(screen.getByRole('heading', { name: group })).toBeInTheDocument()
    }
  })

  it('renders every button variant', () => {
    render(<DesignSystemSection />)
    for (const v of ['default', 'secondary', 'outline', 'ghost', 'destructive', 'link']) {
      expect(screen.getByRole('button', { name: v })).toBeInTheDocument()
    }
  })
})
```

- [ ] **Step 2: Run test, verify it fails**

Run: `yarn workspace frontend run test DesignSystemSection`
Expected: FAIL — cannot resolve `./DesignSystemSection`.

- [ ] **Step 3: Implement the gallery component**

Create `frontend/src/pages/settings/sections/DesignSystemSection.tsx`:
```tsx
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Alert } from '@/components/ui/alert'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { StatCard } from '@/components/ui/stat-card'
import { EmptyState } from '@/components/ui/empty-state'

const BUTTON_VARIANTS = ['default', 'secondary', 'outline', 'ghost', 'destructive', 'link'] as const
const ALERT_VARIANTS = ['error', 'warning', 'info', 'success'] as const

function Group({ name, children }: { name: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3">
      <h2 className="text-sm font-medium text-muted-foreground">{name}</h2>
      <div className="flex flex-wrap items-start gap-3">{children}</div>
    </section>
  )
}

export function DesignSystemSection() {
  return (
    <Card className="space-y-6">
      <div>
        <h1 className="text-lg font-semibold text-foreground">Design System</h1>
        <p className="text-sm text-muted-foreground">
          Live primitives in every variant and state. The implementation target for every page.
        </p>
      </div>

      <Group name="Buttons">
        {BUTTON_VARIANTS.map((v) => (
          <Button key={v} variant={v}>{v}</Button>
        ))}
      </Group>

      <Group name="Cards & stats">
        <StatCard label="Transactions" value="1,284" hint="This month" />
        <StatCard label="Net spend" value="$4,210" delta="+12%" metricKind="loss" />
      </Group>

      <Group name="Badges">
        <Badge>Default</Badge>
        <Badge variant="secondary">Secondary</Badge>
      </Group>

      <Group name="Alerts">
        {ALERT_VARIANTS.map((v) => (
          <Alert key={v} variant={v} className="w-full sm:w-72">
            {v} alert message
          </Alert>
        ))}
      </Group>

      <Group name="Inputs">
        <div className="grid gap-1.5">
          <Label htmlFor="ds-input">Label</Label>
          <Input id="ds-input" placeholder="Placeholder" />
        </div>
      </Group>

      <Group name="States">
        <EmptyState
          className="w-full sm:w-80"
          title="Nothing here yet"
          description="The canonical empty state."
        />
      </Group>
    </Card>
  )
}
```
> If `Badge` rejects `variant="secondary"` or `StatCard` rejects `metricKind`, open the primitive and use a variant it actually defines — the test only asserts buttons + group headings, so adjust the demo content to real props.

- [ ] **Step 4: Run test, verify it passes**

Run: `yarn workspace frontend run test DesignSystemSection`
Expected: PASS (both tests).

- [ ] **Step 5: Wire the route + nav**

In `frontend/src/App.tsx`, add the import beside the other section imports (after line 49):
```tsx
import { DesignSystemSection } from './pages/settings/sections/DesignSystemSection'
```
Add the route inside the `<Route element={<SettingsTabLayout />}>` block (after line 176, the palette route):
```tsx
<Route path="design-system" element={<DesignSystemSection />} />
```
In `frontend/src/pages/settings/SettingsTabLayout.tsx`, add to `SUB_NAV` (after the Palette entry, line 7):
```tsx
  { to: '/settings/design-system', label: 'Design System' },
```
In `frontend/src/pages/settings/useActiveSettingsTopTab.ts`, add a match (after line 25) and include it in the `'settings'` branch:
```tsx
  const isDesignSystem = useMatch('/settings/design-system')
```
Then change line 44 to:
```tsx
  if (isDisplay || isPalette || isGmail || isPartnerInvite || isDesignSystem) return 'settings'
```

- [ ] **Step 6: Verify lint + full frontend tests, then commit**

Run: `yarn workspace frontend run lint` → clean.
Run: `yarn workspace frontend run test settings` → settings-routing tests pass with the new route.
```bash
git add frontend/src/pages/settings/sections/DesignSystemSection.tsx \
  frontend/src/pages/settings/sections/DesignSystemSection.test.tsx \
  frontend/src/App.tsx frontend/src/pages/settings/SettingsTabLayout.tsx \
  frontend/src/pages/settings/useActiveSettingsTopTab.ts
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH git commit -m "feat(settings): add Design System gallery section"
```

---

### Task 4a: AccountsPage characterization test (safety net)

AccountsPage has **no test**. Lock its behavior before migrating so the visual/structural refactor can't silently break it.

**Files:**
- Create: `frontend/src/pages/AccountsPage.test.tsx`

**Interfaces:**
- Consumes: `getJson<Account[]>('/api/accounts')` (AccountsPage.tsx:77).
- Produces: the green-bar gate every later Task-4 step must keep passing.

- [ ] **Step 1: Write the characterization test**

Create `frontend/src/pages/AccountsPage.test.tsx`. Mirror the `IncomePage.test.tsx` harness (mock `../lib/api`, wrap in `ToastProvider`):
```tsx
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ToastProvider } from '@/components/ui/toast'
import { AccountsPage } from './AccountsPage'

vi.mock('../lib/api', () => ({
  getJson: vi.fn(() =>
    Promise.resolve([
      {
        id: 1,
        name: 'Everyday Chequing',
        owner: 'connor',
        type: 'chequing',
        shortCode: 'CHQ',
        defaultCurrency: 'CAD',
        visibility: 'shared',
        closedAt: null,
        creditLimit: null,
      },
    ]),
  ),
  postJson: vi.fn(() => Promise.resolve({})),
  patchJson: vi.fn(() => Promise.resolve({})),
  deleteReq: vi.fn(() => Promise.resolve(undefined)),
}))

function renderPage() {
  return render(
    <ToastProvider>
      <AccountsPage />
    </ToastProvider>,
  )
}

describe('AccountsPage', () => {
  it('renders the page header', async () => {
    renderPage()
    expect(await screen.findByRole('heading', { name: /accounts/i })).toBeInTheDocument()
  })

  it('renders a fetched account row', async () => {
    renderPage()
    expect(await screen.findByText('Everyday Chequing')).toBeInTheDocument()
  })

  it('renders the table column headers', async () => {
    renderPage()
    expect(await screen.findByRole('columnheader', { name: /name/i })).toBeInTheDocument()
    expect(screen.getByRole('columnheader', { name: /default currency/i })).toBeInTheDocument()
  })
})
```
> Align the mock object's field names to the real `Account` type (open `AccountsPage.tsx` / its type import). If a render throws for a missing Router context, wrap `renderPage` in `<MemoryRouter>` from `react-router-dom`.

- [ ] **Step 2: Run test, verify it passes (against UNMODIFIED page)**

Run: `yarn workspace frontend run test AccountsPage`
Expected: PASS — this characterizes current behavior. (If it fails, fix the test/mock to match reality before touching the page — the page is the source of truth here.)

- [ ] **Step 3: Commit**

```bash
git add frontend/src/pages/AccountsPage.test.tsx
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH git commit -m "test(accounts): characterization test before UI migration"
```

---

### Task 4b: Migrate AccountsPage stat cards

Replace the hand-rolled stat grid (`.accountsStats` + four `.statCard`/`.statLabel`/`.statValue`/`.statHint`/`.muted` blocks, lines ~286-307) with the `StatCard` primitive in the blessed stat-grid layout.

**Files:**
- Modify: `frontend/src/pages/AccountsPage.tsx:286-307`

**Interfaces:**
- Consumes: `StatCard` from `@/components/ui/stat-card`; rules' stat-grid layout from Task 2.

- [ ] **Step 1: Add the import**

In `AccountsPage.tsx`, alongside the other `@/components/ui/*` imports:
```tsx
import { StatCard } from '@/components/ui/stat-card'
```

- [ ] **Step 2: Replace the stat grid markup**

Replace the `.accountsStats` container and its four `.statCard` children (lines ~286-307) with:
```tsx
<div className="mb-4 grid gap-3 grid-cols-[repeat(auto-fit,minmax(180px,1fr))]">
  <StatCard label={/* existing label 1 */} value={/* existing value 1 */} hint={/* existing hint 1 */} />
  <StatCard label={/* label 2 */} value={/* value 2 */} hint={/* hint 2 */} />
  <StatCard label={/* label 3 */} value={/* value 3 */} hint={/* hint 3 */} />
  <StatCard label={/* label 4 */} value={/* value 4 */} hint={/* hint 4 */} />
</div>
```
Copy the existing label/value/hint expressions verbatim from the four old blocks into the `label`/`value`/`hint` props. Delete the now-unused `.statCard`/`.statLabel`/`.statValue`/`.statHint` markup.

- [ ] **Step 3: Run the characterization test**

Run: `yarn workspace frontend run test AccountsPage`
Expected: PASS (header + row + columns still render).

- [ ] **Step 4: Commit**

```bash
git add frontend/src/pages/AccountsPage.tsx
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH git commit -m "refactor(accounts): stat grid uses StatCard primitive"
```

---

### Task 4c: Migrate AccountsPage create form

Replace `.accountsFormCard`, `.formGrid`, `.accountsCardHeader`, `.req`, and form `.muted` (lines ~309-394) with `Card` + Tailwind token utilities.

**Files:**
- Modify: `frontend/src/pages/AccountsPage.tsx:309-394`

- [ ] **Step 1: Replace the form scaffolding classes**

Apply these exact swaps (keep all field markup, handlers, and primitives — `Input`/`Label`/`Button` — unchanged):
- `<Card className="accountsFormCard">` → `<Card className="mb-4">`
- `.accountsCardHeader` div → `className="mb-4 flex flex-wrap items-start justify-between gap-3"`
- `.formGrid` div → `className="mb-3 grid gap-3 grid-cols-[repeat(auto-fill,minmax(min(100%,180px),1fr))]"`
- `<span className="req">` → `<span className="text-danger">`
- any `className="muted"` help text → `className="text-sm text-muted-foreground"`

- [ ] **Step 2: Run the characterization test**

Run: `yarn workspace frontend run test AccountsPage`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/pages/AccountsPage.tsx
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH git commit -m "refactor(accounts): create form uses token utilities, drops App.css classes"
```

---

### Task 4d: Migrate AccountsPage error banner, table wrapper, and empty/loading state

**Files:**
- Modify: `frontend/src/pages/AccountsPage.tsx` (error ~396-400; table wrap ~404-410; empty row ~641-645)

**Interfaces:**
- Consumes: `Alert` from `@/components/ui/alert`; `EmptyTableRow` from `@/components/ui/empty-state`; existing `Table*` primitives.

- [ ] **Step 1: Add imports**

```tsx
import { Alert } from '@/components/ui/alert'
import { EmptyTableRow } from '@/components/ui/empty-state'
```

- [ ] **Step 2: Replace the error banner**

The `.error` element (~line 397) → 
```tsx
{error ? <Alert variant="error" className="mb-4">{error}</Alert> : null}
```
(Use the existing error state variable name; keep the conditional shape it already had.)

- [ ] **Step 3: Drop the redundant table wrapper + class**

`Table` already self-wraps in an overflow container and sets `w-full text-sm`, so the `.tableWrap` div (line 409) and `className="table"` (line 410) are redundant:
- Delete the `<div className="tableWrap">` wrapper and its closing `</div>` around the `<Table>`.
- Change `<Table className="table">` → `<Table>`.

- [ ] **Step 4: Replace the empty state row**

The empty `.emptyState`/`.pad` cell (~641-645) → use the primitive:
```tsx
<EmptyTableRow colSpan={9} title="No accounts yet" description="Add your first account above." />
```
(Match `colSpan` to the table's column count — 9 per the header at lines 413-421. Reuse the existing empty copy if it differs.)

- [ ] **Step 5: Run the characterization test**

Run: `yarn workspace frontend run test AccountsPage`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/pages/AccountsPage.tsx
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH git commit -m "refactor(accounts): Alert error banner, primitive table + EmptyTableRow"
```

---

### Task 4e: Kill inline styles + verify pilot done

**Files:**
- Modify: `frontend/src/pages/AccountsPage.tsx` (inline styles at ~460, ~613, ~624)

- [ ] **Step 1: Replace the three inline styles with utilities**

- Line ~460 `<p style={{ marginTop: '0.125rem' }}>` → `className="mt-0.5"` (merge into existing className; replace the `.muted` here too with `text-sm text-muted-foreground` if present).
- Line ~613 `<div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>` → `className="flex flex-col gap-1"`.
- Line ~624 `<textarea style={{ width: '100%', resize: 'vertical' }}>` → `className="w-full resize-y"` (merge with any existing className).

- [ ] **Step 2: Verify zero inline styles and zero rules-covered classes remain**

Run from repo root:
```bash
cd frontend/src
echo "inline styles:"; grep -c "style={{" pages/AccountsPage.tsx
echo "rules-covered App.css classes (expect 0):"
grep -oE 'className="(accountsStats|statCard|statLabel|statValue|statHint|accountsFormCard|formGrid|accountsCardHeader|req|error|tableWrap|table|emptyState|pad)"' pages/AccountsPage.tsx | wc -l
echo "remaining className=\"muted\" (expect 0):"; grep -c 'className="muted"' pages/AccountsPage.tsx
```
Expected: inline styles `0`; rules-covered classes `0`; `muted` `0`.
> Any App.css class that is NOT in the rules' covered set (e.g. a niche one the rules don't address) → log it in `docs/ui-rules.md` under a new "## Rule gaps found during pilot" section instead of leaving it silently. Then it's covered before the sweep.

- [ ] **Step 3: Full gates**

Run:
```bash
yarn workspace frontend run lint
yarn workspace frontend run test AccountsPage
```
Both clean/green.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/pages/AccountsPage.tsx docs/ui-rules.md
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH git commit -m "refactor(accounts): remove inline styles; pilot migration complete"
```

---

### Task 5: Ranked sweep backlog

The worst-first ordered list of the remaining 52 pages — input to sub-project 2+. Produced, not executed.

**Files:**
- Create: `docs/superpowers/specs/2026-06-17-ui-sweep-backlog.md`

- [ ] **Step 1: Generate the ranking**

Run from repo root:
```bash
cd frontend/src
printf "%s\t%s\t%s\t%s\n" page inline rawclass lines
for f in pages/*.tsx; do
  case "$f" in *.test.tsx) continue;; esac
  [ "$(basename "$f")" = "AccountsPage.tsx" ] && continue   # pilot done
  inl=$(grep -c "style={{" "$f")
  raw=$(grep -coE 'className="(page|muted|row|emptyState|card|statCard|formGrid|tableWrap|table|error|req|pad|statLabel|statValue|statHint)"' "$f")
  ln=$(wc -l < "$f")
  printf "%s\t%s\t%s\t%s\n" "$(basename "$f")" "$inl" "$raw" "$ln"
done | sort -t$'\t' -k3 -rn
```

- [ ] **Step 2: Write the backlog doc**

Create `docs/superpowers/specs/2026-06-17-ui-sweep-backlog.md`: paste the ranked table (columns: page, inline-style count, raw-class count, lines), sorted worst-first by raw-class count then inline count. Add a one-line note: "Each page is its own sweep task; migrate top-down using `docs/ui-rules.md` and the AccountsPage migration (commits in this plan) as the worked example."

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/specs/2026-06-17-ui-sweep-backlog.md
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH git commit -m "docs(ui): ranked page-sweep backlog (worst-first)"
```

---

## Self-Review

- **Spec coverage:** audit → Task 1; rules doc → Task 2; living gallery → Task 3; pilot AccountsPage end-to-end → Tasks 4a-4e (DoD: zero inline styles, zero rules-covered classes, tests green, lint clean); ranked backlog → Task 5. Out-of-scope items (primitive API refactor, App.css teardown, other 52 pages) are explicitly deferred. ✓
- **Placeholder scan:** code steps carry real code; the only intentional `/* existing … */` markers (Task 4b) are "copy the verbatim expression from the adjacent old block" instructions, not unresolved TODOs. ✓
- **Type consistency:** `StatCard` props (`label`/`value`/`hint`/`delta`/`metricKind`) match `stat-card.tsx`; `Alert variant` ∈ {error,warning,info,success} matches `alert.tsx`; `EmptyTableRow`(`colSpan`/`title`/`description`) matches `empty-state.tsx`; settings wiring matches `App.tsx`/`SettingsTabLayout.tsx`/`useActiveSettingsTopTab.ts` line refs. ✓
