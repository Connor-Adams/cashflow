# Settings Tabs + Sidebar Restructure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split the 2,198-line `frontend/src/pages/SettingsPage.tsx` into 5 top tabs (Settings, Imports, Enrichment, Contacts, Budgets) with a left sub-nav under the Settings tab, deep-linked via nested react-router routes, with every section preserved verbatim.

**Architecture:** Build the new tree at `frontend/src/pages/settings/` in parallel with the existing monolith (which remains routed at `/settings` until the final switchover). Nine new files: a shell (`SettingsPage.tsx`), a Settings-tab layout wrapper (`SettingsTabLayout.tsx`), a URL-active-tab hook, three sidebar sections, and four top-tab components. At the end, swap the App.tsx route block to use the new shell and delete the old monolith.

**Tech Stack:** React + TypeScript, react-router-dom v6 (nested children + `<Outlet />` + `useMatch`), existing `Tabs` primitive at `frontend/src/components/ui/tabs.tsx`, Vitest + React Testing Library. No backend changes.

**Spec:** `docs/superpowers/specs/2026-05-23-settings-tabs-design.md`

---

## File map

**New files:**
- `frontend/src/pages/settings/SettingsPage.tsx` — outer shell (PageHeader + top Tabs + Outlet)
- `frontend/src/pages/settings/SettingsTabLayout.tsx` — left sidebar + Outlet, only mounted under Settings sub-routes
- `frontend/src/pages/settings/useActiveSettingsTopTab.ts` — URL → active top tab id
- `frontend/src/pages/settings/sections/DisplaySection.tsx`
- `frontend/src/pages/settings/sections/GmailSection.tsx`
- `frontend/src/pages/settings/sections/PartnerInviteSection.tsx`
- `frontend/src/pages/settings/tabs/ImportsTab.tsx`
- `frontend/src/pages/settings/tabs/EnrichmentTab.tsx`
- `frontend/src/pages/settings/tabs/ContactsTab.tsx`
- `frontend/src/pages/settings/tabs/BudgetsTab.tsx`

**Tests (colocated):**
- `frontend/src/pages/settings/SettingsPage.test.tsx`
- `frontend/src/pages/settings/SettingsTabLayout.test.tsx`
- `frontend/src/pages/settings/useActiveSettingsTopTab.test.ts`
- One `*.test.tsx` per section/tab file

**Modified:**
- `frontend/src/App.tsx` — replace single settings route with nested block

**Deleted (final task):**
- `frontend/src/pages/SettingsPage.tsx`

## Source line ranges in the current monolith

Reference points in `frontend/src/pages/SettingsPage.tsx` (commit `ff9b7a0` baseline):

| Section | JSX line range | Notes |
|---|---|---|
| `export function SettingsPage()` | 217 | component start |
| Hooks block (all useState/useEffect/handlers) | 217–984 | each section's hooks must travel with it |
| `<PageHeader>` | 988–996 | replaced in new shell |
| Display width Card | 998–1023 | uses `layoutWidth`, `setLayoutWidth` |
| Connect Gmail Card | 1024–1274 | uses `gmail*`, `allowlist*` state |
| Import receipts Card | 1275–1498 | uses `receipt*`, `csv*` state |
| Enrichment maintenance Card | 1499–1627 | uses `backfill*` state |
| Enrichment dashboard Card | 1628–1752 | uses `stats*` state |
| Partner invite Card | 1753–1768 | uses `invite`, `err` |
| Receipt capture Card | 1769–1862 | uses capture-token state |
| Contacts ledger Card | 1863–1919 | uses `contacts`, `rename*` state |
| Monthly budgets Card | 1920–~2150 | uses `budget*` state, plus `budgetCategoryDatalistId` |

When extracting, also lift any `useEffect`, `useMemo`, helper functions, and constants used only by that section. Use grep on the state-variable names to find all references.

## Build sequence

Tasks 1–10 add code without touching the live `/settings` route. The old `SettingsPage.tsx` keeps rendering until Task 11 swaps the route. This means the new files are dead code for tasks 1–10 (only reached by their own tests), so each commit ships a working app.

---

### Task 1: Scaffold directory + `useActiveSettingsTopTab` hook

**Files:**
- Create: `frontend/src/pages/settings/useActiveSettingsTopTab.ts`
- Create: `frontend/src/pages/settings/useActiveSettingsTopTab.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// frontend/src/pages/settings/useActiveSettingsTopTab.test.ts
import { renderHook } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { describe, it, expect } from 'vitest'
import { useActiveSettingsTopTab } from './useActiveSettingsTopTab'

function wrapper(initialPath: string) {
  return ({ children }: { children: React.ReactNode }) => (
    <MemoryRouter initialEntries={[initialPath]}>
      <Routes>
        <Route path="/settings/*" element={<>{children}</>} />
      </Routes>
    </MemoryRouter>
  )
}

describe('useActiveSettingsTopTab', () => {
  it.each([
    ['/settings/display', 'settings'],
    ['/settings/gmail', 'settings'],
    ['/settings/partner-invite', 'settings'],
    ['/settings/imports', 'imports'],
    ['/settings/enrichment', 'enrichment'],
    ['/settings/contacts', 'contacts'],
    ['/settings/budgets', 'budgets'],
  ])('maps %s to %s', (path, expected) => {
    const { result } = renderHook(() => useActiveSettingsTopTab(), {
      wrapper: wrapper(path),
    })
    expect(result.current).toBe(expected)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && yarn vitest run src/pages/settings/useActiveSettingsTopTab.test.ts`
Expected: FAIL with "Cannot find module './useActiveSettingsTopTab'"

- [ ] **Step 3: Implement the hook**

```ts
// frontend/src/pages/settings/useActiveSettingsTopTab.ts
import { useMatch } from 'react-router-dom'

export type SettingsTopTab =
  | 'settings'
  | 'imports'
  | 'enrichment'
  | 'contacts'
  | 'budgets'

export function useActiveSettingsTopTab(): SettingsTopTab {
  const isDisplay = useMatch('/settings/display')
  const isGmail = useMatch('/settings/gmail')
  const isPartnerInvite = useMatch('/settings/partner-invite')
  const isImports = useMatch('/settings/imports')
  const isEnrichment = useMatch('/settings/enrichment')
  const isContacts = useMatch('/settings/contacts')
  const isBudgets = useMatch('/settings/budgets')

  if (isDisplay || isGmail || isPartnerInvite) return 'settings'
  if (isImports) return 'imports'
  if (isEnrichment) return 'enrichment'
  if (isContacts) return 'contacts'
  if (isBudgets) return 'budgets'
  return 'settings'
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && yarn vitest run src/pages/settings/useActiveSettingsTopTab.test.ts`
Expected: PASS (7 cases)

- [ ] **Step 5: Commit**

```bash
git add frontend/src/pages/settings/useActiveSettingsTopTab.ts \
        frontend/src/pages/settings/useActiveSettingsTopTab.test.ts
git commit -m "feat(settings): add useActiveSettingsTopTab hook"
```

---

### Task 2: Outer shell — `SettingsPage.tsx` (no children content yet)

**Files:**
- Create: `frontend/src/pages/settings/SettingsPage.tsx`
- Create: `frontend/src/pages/settings/SettingsPage.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// frontend/src/pages/settings/SettingsPage.test.tsx
import { render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { describe, it, expect, vi } from 'vitest'
import { SettingsPage } from './SettingsPage'

// Stub useAuth so PageHeader can read household/email without real auth wiring
vi.mock('../../lib/useAuth', () => ({
  useAuth: () => ({
    user: { household: { name: 'Test HH' }, email: 't@x.io', globalRole: null },
  }),
}))

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/settings" element={<SettingsPage />}>
          <Route path="display" element={<div>display-marker</div>} />
          <Route path="imports" element={<div>imports-marker</div>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  )
}

describe('SettingsPage shell', () => {
  it('renders the Settings page header', () => {
    renderAt('/settings/display')
    expect(screen.getByRole('heading', { name: /settings/i })).toBeInTheDocument()
  })

  it('renders five top tabs', () => {
    renderAt('/settings/display')
    const tabs = screen.getAllByRole('tab')
    expect(tabs.map((t) => t.textContent)).toEqual([
      'Settings',
      'Imports',
      'Enrichment',
      'Contacts',
      'Budgets',
    ])
  })

  it('marks Settings tab active for /settings/display', () => {
    renderAt('/settings/display')
    const settingsTab = screen.getByRole('tab', { name: 'Settings' })
    expect(settingsTab).toHaveAttribute('aria-selected', 'true')
  })

  it('marks Imports tab active for /settings/imports', () => {
    renderAt('/settings/imports')
    expect(screen.getByRole('tab', { name: 'Imports' })).toHaveAttribute(
      'aria-selected',
      'true',
    )
  })

  it('renders child outlet content', () => {
    renderAt('/settings/imports')
    expect(screen.getByText('imports-marker')).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && yarn vitest run src/pages/settings/SettingsPage.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the shell**

```tsx
// frontend/src/pages/settings/SettingsPage.tsx
import { Outlet, useNavigate } from 'react-router-dom'
import { PageHeader } from '@/components/ui/page-header'
import { Tabs, type TabItem } from '@/components/ui/tabs'
import { useAuth } from '../../lib/useAuth'
import { useActiveSettingsTopTab, type SettingsTopTab } from './useActiveSettingsTopTab'

const TOP_TABS: TabItem[] = [
  { value: 'settings', label: 'Settings' },
  { value: 'imports', label: 'Imports' },
  { value: 'enrichment', label: 'Enrichment' },
  { value: 'contacts', label: 'Contacts' },
  { value: 'budgets', label: 'Budgets' },
]

const TOP_TAB_PATHS: Record<SettingsTopTab, string> = {
  settings: '/settings/display',
  imports: '/settings/imports',
  enrichment: '/settings/enrichment',
  contacts: '/settings/contacts',
  budgets: '/settings/budgets',
}

export function SettingsPage() {
  const auth = useAuth()
  const navigate = useNavigate()
  const activeTop = useActiveSettingsTopTab()

  return (
    <div className="page">
      <PageHeader
        title="Settings"
        description={
          <>
            {auth.user?.household?.name} · {auth.user?.email}
            {auth.user?.globalRole === 'superadmin' ? ' · God mode' : ''}
          </>
        }
      />
      <div className="settingsTopTabs">
        <Tabs
          items={TOP_TABS}
          value={activeTop}
          onValueChange={(v) => navigate(TOP_TAB_PATHS[v as SettingsTopTab])}
        />
      </div>
      <Outlet />
    </div>
  )
}
```

The `@/` alias resolves to `frontend/src/` (configured in `frontend/vite.config.ts` and `frontend/tsconfig.app.json`). `PageHeader` is a named export from `frontend/src/components/ui/page-header.tsx`. The imports above are correct as written.

- [ ] **Step 4: Run tests to verify pass**

Run: `cd frontend && yarn vitest run src/pages/settings/SettingsPage.test.tsx`
Expected: PASS (5 cases)

- [ ] **Step 5: Commit**

```bash
git add frontend/src/pages/settings/SettingsPage.tsx \
        frontend/src/pages/settings/SettingsPage.test.tsx
git commit -m "feat(settings): add new SettingsPage shell with top tabs"
```

---

### Task 3: Settings tab wrapper — `SettingsTabLayout.tsx`

**Files:**
- Create: `frontend/src/pages/settings/SettingsTabLayout.tsx`
- Create: `frontend/src/pages/settings/SettingsTabLayout.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// frontend/src/pages/settings/SettingsTabLayout.test.tsx
import { render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { describe, it, expect } from 'vitest'
import { SettingsTabLayout } from './SettingsTabLayout'

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/settings" element={<SettingsTabLayout />}>
          <Route path="display" element={<div>display-marker</div>} />
          <Route path="gmail" element={<div>gmail-marker</div>} />
          <Route path="partner-invite" element={<div>invite-marker</div>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  )
}

describe('SettingsTabLayout', () => {
  it('renders three sidebar nav links', () => {
    renderAt('/settings/display')
    expect(screen.getByRole('link', { name: 'Display' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Gmail' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Partner invite' })).toBeInTheDocument()
  })

  it('renders the active outlet content', () => {
    renderAt('/settings/gmail')
    expect(screen.getByText('gmail-marker')).toBeInTheDocument()
  })

  it('marks the active link via aria-current', () => {
    renderAt('/settings/display')
    expect(screen.getByRole('link', { name: 'Display' })).toHaveAttribute(
      'aria-current',
      'page',
    )
    expect(screen.getByRole('link', { name: 'Gmail' })).not.toHaveAttribute(
      'aria-current',
    )
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && yarn vitest run src/pages/settings/SettingsTabLayout.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the layout**

```tsx
// frontend/src/pages/settings/SettingsTabLayout.tsx
import { NavLink, Outlet } from 'react-router-dom'

type SubNavItem = { to: string; label: string }

const SUB_NAV: SubNavItem[] = [
  { to: '/settings/display', label: 'Display' },
  { to: '/settings/gmail', label: 'Gmail' },
  { to: '/settings/partner-invite', label: 'Partner invite' },
]

export function SettingsTabLayout() {
  return (
    <div className="settingsTabLayout">
      <nav className="settingsSubnav" aria-label="Settings sections">
        {SUB_NAV.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            className={({ isActive }) =>
              isActive ? 'settingsSubnav__link isActive' : 'settingsSubnav__link'
            }
          >
            {item.label}
          </NavLink>
        ))}
      </nav>
      <div className="settingsTabLayout__content">
        <Outlet />
      </div>
    </div>
  )
}
```

- [ ] **Step 4: Add minimal CSS**

The classes `settingsTabLayout`, `settingsSubnav`, `settingsSubnav__link`, `settingsTabLayout__content` are new. Find the current settings stylesheet — likely `frontend/src/pages/SettingsPage.module.css` or a global stylesheet referenced by the current page.

Run: `grep -rn "settingsDisplayCard\|accountsFormCard" frontend/src/ --include="*.css" --include="*.scss" 2>&1 | head -5`

Add (in the same file the other settings styles live in):

```css
.settingsTabLayout {
  display: grid;
  grid-template-columns: 200px 1fr;
  gap: 1.5rem;
}

.settingsSubnav {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}

.settingsSubnav__link {
  padding: 0.5rem 0.75rem;
  border-radius: 0.375rem;
  color: var(--color-foreground-muted, inherit);
  text-decoration: none;
  font-size: 0.875rem;
}

.settingsSubnav__link.isActive,
.settingsSubnav__link[aria-current="page"] {
  background: var(--color-surface-subtle, rgba(0,0,0,0.04));
  color: var(--color-foreground, inherit);
}

@media (max-width: 768px) {
  .settingsTabLayout {
    grid-template-columns: 1fr;
  }
  .settingsSubnav {
    flex-direction: row;
    overflow-x: auto;
  }
}
```

If no settings stylesheet exists, create `frontend/src/pages/settings/settings.module.css` and import it in `SettingsTabLayout.tsx`. Adjust class names to use the module's import object if you go that route.

- [ ] **Step 5: Run tests to verify pass**

Run: `cd frontend && yarn vitest run src/pages/settings/SettingsTabLayout.test.tsx`
Expected: PASS (3 cases)

- [ ] **Step 6: Commit**

```bash
git add frontend/src/pages/settings/SettingsTabLayout.tsx \
        frontend/src/pages/settings/SettingsTabLayout.test.tsx \
        frontend/src/pages/settings/settings.module.css   # if created
git commit -m "feat(settings): add SettingsTabLayout with left sub-nav"
```

---

### Task 4: Extract `DisplaySection.tsx`

**Files:**
- Create: `frontend/src/pages/settings/sections/DisplaySection.tsx`
- Create: `frontend/src/pages/settings/sections/DisplaySection.test.tsx`
- Reference: `frontend/src/pages/SettingsPage.tsx:998-1023` (JSX) + line 220 (`useLayoutWidth`) + `layoutWidthOptions` constant

- [ ] **Step 1: Find the section's dependencies**

Run: `grep -n "layoutWidth\|layoutWidthOptions\|useLayoutWidth" frontend/src/pages/SettingsPage.tsx`

Note every line that uses these names. Imports of `useLayoutWidth` and `layoutWidthOptions` need to come along.

- [ ] **Step 2: Write the failing test**

```tsx
// frontend/src/pages/settings/sections/DisplaySection.test.tsx
import { render, screen } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import { DisplaySection } from './DisplaySection'

describe('DisplaySection', () => {
  it('renders the display width heading', () => {
    render(<DisplaySection />)
    expect(screen.getByRole('heading', { name: /display width/i })).toBeInTheDocument()
  })

  it('renders the display-width radiogroup', () => {
    render(<DisplaySection />)
    expect(screen.getByRole('radiogroup', { name: /display width/i })).toBeInTheDocument()
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd frontend && yarn vitest run src/pages/settings/sections/DisplaySection.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 4: Extract the section**

Copy the Card JSX block from `frontend/src/pages/SettingsPage.tsx:998-1023` into the new file. Wrap it in a function component. Move the `useLayoutWidth` call into the component body. Verify that any imports the section uses (`Card`, `useLayoutWidth`, `layoutWidthOptions`) are imported in the new file.

```tsx
// frontend/src/pages/settings/sections/DisplaySection.tsx
import { Card } from '@/components/ui/card'
import { useLayoutWidth, layoutWidthOptions } from '@/lib/layoutWidth'

export function DisplaySection() {
  const [layoutWidth, setLayoutWidth] = useLayoutWidth()

  return (
    <Card className="settingsDisplayCard">
      {/* paste lines 999-1022 from SettingsPage.tsx here */}
    </Card>
  )
}
```

To paste the JSX correctly, read lines 999–1022 of `frontend/src/pages/SettingsPage.tsx` and copy them inside the `<Card>` body. The `layoutWidth` / `setLayoutWidth` references already match.

- [ ] **Step 5: Run tests to verify pass**

Run: `cd frontend && yarn vitest run src/pages/settings/sections/DisplaySection.test.tsx`
Expected: PASS (2 cases)

- [ ] **Step 6: Commit**

```bash
git add frontend/src/pages/settings/sections/DisplaySection.tsx \
        frontend/src/pages/settings/sections/DisplaySection.test.tsx
git commit -m "feat(settings): extract DisplaySection"
```

---

### Task 5: Extract `PartnerInviteSection.tsx`

**Files:**
- Create: `frontend/src/pages/settings/sections/PartnerInviteSection.tsx`
- Create: `frontend/src/pages/settings/sections/PartnerInviteSection.test.tsx`
- Reference: `frontend/src/pages/SettingsPage.tsx:1753-1768`

- [ ] **Step 1: Find the section's dependencies**

Run: `grep -n "invite\b\|setInvite\|requestInvite\|partnerInvite" frontend/src/pages/SettingsPage.tsx`

Capture all referenced state hooks (`invite`, `setInvite`, possibly `err`/`setErr` if used here — verify by reading lines 1753–1768) and any handler functions called from this Card's JSX.

- [ ] **Step 2: Write the failing test**

```tsx
// frontend/src/pages/settings/sections/PartnerInviteSection.test.tsx
import { render, screen } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import { PartnerInviteSection } from './PartnerInviteSection'

describe('PartnerInviteSection', () => {
  it('renders the heading', () => {
    render(<PartnerInviteSection />)
    expect(
      screen.getByRole('heading', { name: /partner invite/i }),
    ).toBeInTheDocument()
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd frontend && yarn vitest run src/pages/settings/sections/PartnerInviteSection.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 4: Extract the section**

Read `frontend/src/pages/SettingsPage.tsx:1753-1768` and copy into:

```tsx
// frontend/src/pages/settings/sections/PartnerInviteSection.tsx
import { useState } from 'react'
import { Card } from '@/components/ui/card'
// ...other imports as needed (Button, etc.) — verify by reading source

export function PartnerInviteSection() {
  const [invite, setInvite] = useState<string | null>(null)
  // ... any other invite-specific state and handlers from the monolith

  return (
    <Card className="accountsFormCard">
      {/* paste lines 1754-1767 here */}
    </Card>
  )
}
```

Verify that `err` / `setErr` is used by this section in the source — if so, lift its declaration into this component as `const [err, setErr] = useState<string | null>(null)`. If `err` is also used by another section, scope a section-local version per file (each section's error state is independent — they don't share UI).

- [ ] **Step 5: Run tests to verify pass**

Run: `cd frontend && yarn vitest run src/pages/settings/sections/PartnerInviteSection.test.tsx`
Expected: PASS (1 case)

- [ ] **Step 6: Commit**

```bash
git add frontend/src/pages/settings/sections/PartnerInviteSection.tsx \
        frontend/src/pages/settings/sections/PartnerInviteSection.test.tsx
git commit -m "feat(settings): extract PartnerInviteSection"
```

---

### Task 6: Extract `GmailSection.tsx`

**Files:**
- Create: `frontend/src/pages/settings/sections/GmailSection.tsx`
- Create: `frontend/src/pages/settings/sections/GmailSection.test.tsx`
- Reference: `frontend/src/pages/SettingsPage.tsx:1024-1274` (JSX) + all `gmail*` and `allowlist*` state declared between lines 252–266 + handlers

- [ ] **Step 1: Find the section's dependencies**

Run:

```bash
grep -n "gmailStatus\|gmailScanning\|gmailScanResult\|gmailError\|gmailScanFeed\|gmailScanLive\|allowlist\|allowlistDraft" frontend/src/pages/SettingsPage.tsx | head -40
```

List every state hook, every `useEffect`, and every handler function whose body references those names. They all travel into this file.

- [ ] **Step 2: Write the failing test**

```tsx
// frontend/src/pages/settings/sections/GmailSection.test.tsx
import { render, screen } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { GmailSection } from './GmailSection'

// Stub network fetches so the effect doesn't blow up
vi.stubGlobal('fetch', vi.fn(() =>
  Promise.resolve({ ok: true, json: () => Promise.resolve({}) } as Response),
))

describe('GmailSection', () => {
  it('renders the Connect Gmail heading', () => {
    render(<GmailSection />)
    expect(screen.getByRole('heading', { name: /connect gmail/i })).toBeInTheDocument()
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd frontend && yarn vitest run src/pages/settings/sections/GmailSection.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 4: Extract the section**

This is the largest section (~250 lines). Process:

1. Open `frontend/src/pages/SettingsPage.tsx` and identify the contiguous JSX block at lines 1024–1274.
2. Identify every `useState` declared between lines 252–266 plus any farther-down ones whose name starts with `gmail` or `allowlist`.
3. Identify every `useEffect` in the 217–984 range whose dependency array or body references those names.
4. Identify every helper function (function declared inside the component or as a top-level helper) called from the JSX block or referenced by those effects.
5. Copy state + effects + helpers + JSX into the new file, wrapped in:

```tsx
// frontend/src/pages/settings/sections/GmailSection.tsx
import { useEffect, useState } from 'react'
import { Card } from '@/components/ui/card'
// ...all the other imports the section uses

export function GmailSection() {
  // all gmail* and allowlist* state declarations
  // all gmail/allowlist useEffects
  // all gmail/allowlist handler functions

  return (
    <Card className="accountsFormCard">
      {/* the JSX from lines 1024-1274 */}
    </Card>
  )
}
```

Cross-check: after writing, verify every identifier referenced inside the component is either imported, declared in the component body, or a JSX intrinsic.

- [ ] **Step 5: Run tests to verify pass**

Run: `cd frontend && yarn vitest run src/pages/settings/sections/GmailSection.test.tsx`
Expected: PASS (1 case)

- [ ] **Step 6: Verify nothing else broke**

Run: `cd frontend && yarn vitest run`
Expected: All tests still pass (the old SettingsPage is still untouched at this point — its tests, if any, should also still pass).

- [ ] **Step 7: Commit**

```bash
git add frontend/src/pages/settings/sections/GmailSection.tsx \
        frontend/src/pages/settings/sections/GmailSection.test.tsx
git commit -m "feat(settings): extract GmailSection"
```

---

### Task 7: Extract `ContactsTab.tsx`

**Files:**
- Create: `frontend/src/pages/settings/tabs/ContactsTab.tsx`
- Create: `frontend/src/pages/settings/tabs/ContactsTab.test.tsx`
- Reference: `frontend/src/pages/SettingsPage.tsx:1863-1919`

- [ ] **Step 1: Find dependencies**

Run: `grep -n "contacts\|setContacts\|renameTarget\|renameValue\|renameSaving\|setRename" frontend/src/pages/SettingsPage.tsx | head -30`

- [ ] **Step 2: Write the failing test**

```tsx
// frontend/src/pages/settings/tabs/ContactsTab.test.tsx
import { render, screen } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { ContactsTab } from './ContactsTab'

vi.stubGlobal('fetch', vi.fn(() =>
  Promise.resolve({ ok: true, json: () => Promise.resolve([]) } as Response),
))

describe('ContactsTab', () => {
  it('renders the Contacts ledger heading', () => {
    render(<ContactsTab />)
    expect(
      screen.getByRole('heading', { name: /contacts ledger/i }),
    ).toBeInTheDocument()
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd frontend && yarn vitest run src/pages/settings/tabs/ContactsTab.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 4: Extract**

Same process as Task 6: lift `contacts`, `renameTarget`, `renameValue`, `renameSaving` state, related effects, handlers, and the JSX from lines 1863–1919 into `ContactsTab.tsx`. The internal `<Card>` per-contact loop is part of the same JSX block — copy it intact.

```tsx
// frontend/src/pages/settings/tabs/ContactsTab.tsx
import { useEffect, useState } from 'react'
import { Card } from '@/components/ui/card'

export function ContactsTab() {
  // contacts state, rename state, effects, handlers — all from the monolith

  return (
    <Card className="accountsFormCard">
      {/* JSX from 1863-1919 */}
    </Card>
  )
}
```

- [ ] **Step 5: Run tests to verify pass**

Run: `cd frontend && yarn vitest run src/pages/settings/tabs/ContactsTab.test.tsx`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/pages/settings/tabs/ContactsTab.tsx \
        frontend/src/pages/settings/tabs/ContactsTab.test.tsx
git commit -m "feat(settings): extract ContactsTab"
```

---

### Task 8: Extract `BudgetsTab.tsx`

**Files:**
- Create: `frontend/src/pages/settings/tabs/BudgetsTab.tsx`
- Create: `frontend/src/pages/settings/tabs/BudgetsTab.test.tsx`
- Reference: `frontend/src/pages/SettingsPage.tsx:1920-end` (the budget Card extends from 1920 through end of JSX)

- [ ] **Step 1: Find dependencies**

Run: `grep -n "budgets\|budgetForm\|budgetEdit\|budgetSubmitting\|budgetCategoryHints\|emptyBudgetForm\|BudgetFormState\|budgetCategoryDatalistId" frontend/src/pages/SettingsPage.tsx | head -40`

Also lift any top-level constants like `emptyBudgetForm` and types like `BudgetFormState` — they may be declared above line 217 in the source file.

- [ ] **Step 2: Write the failing test**

```tsx
// frontend/src/pages/settings/tabs/BudgetsTab.test.tsx
import { render, screen } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { BudgetsTab } from './BudgetsTab'

vi.stubGlobal('fetch', vi.fn(() =>
  Promise.resolve({ ok: true, json: () => Promise.resolve([]) } as Response),
))

describe('BudgetsTab', () => {
  it('renders the Monthly budgets heading', () => {
    render(<BudgetsTab />)
    expect(
      screen.getByRole('heading', { name: /monthly budgets/i }),
    ).toBeInTheDocument()
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd frontend && yarn vitest run src/pages/settings/tabs/BudgetsTab.test.tsx`
Expected: FAIL.

- [ ] **Step 4: Extract**

Lift all `budget*` state, the `emptyBudgetForm` constant and `BudgetFormState` type, related effects, handlers, the `useMemo` block at lines 974–981, and the JSX from line 1920 to the closing `</Card>` of the budgets section. Find the exact closing line by reading from 1920 forward in the source.

- [ ] **Step 5: Run tests to verify pass**

Run: `cd frontend && yarn vitest run src/pages/settings/tabs/BudgetsTab.test.tsx`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/pages/settings/tabs/BudgetsTab.tsx \
        frontend/src/pages/settings/tabs/BudgetsTab.test.tsx
git commit -m "feat(settings): extract BudgetsTab"
```

---

### Task 9: Extract `ImportsTab.tsx` (combines Import receipts + Receipt capture)

**Files:**
- Create: `frontend/src/pages/settings/tabs/ImportsTab.tsx`
- Create: `frontend/src/pages/settings/tabs/ImportsTab.test.tsx`
- Reference: `frontend/src/pages/SettingsPage.tsx:1275-1498` (Import receipts) + `1769-1862` (Receipt capture)

- [ ] **Step 1: Find dependencies**

Run:

```bash
grep -n "receiptText\|receiptBusy\|receiptError\|receiptResult\|csvVendor\|csvResult\|captureToken\|bookmarklet" frontend/src/pages/SettingsPage.tsx | head -40
```

- [ ] **Step 2: Write the failing test**

```tsx
// frontend/src/pages/settings/tabs/ImportsTab.test.tsx
import { render, screen } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { ImportsTab } from './ImportsTab'

vi.stubGlobal('fetch', vi.fn(() =>
  Promise.resolve({ ok: true, json: () => Promise.resolve({}) } as Response),
))

describe('ImportsTab', () => {
  it('renders both Import receipts and Receipt capture headings', () => {
    render(<ImportsTab />)
    expect(screen.getByRole('heading', { name: /import receipts/i })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: /receipt capture/i })).toBeInTheDocument()
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd frontend && yarn vitest run src/pages/settings/tabs/ImportsTab.test.tsx`
Expected: FAIL.

- [ ] **Step 4: Extract**

Lift state, effects, and handlers for both `receipt*`/`csv*` (Import receipts) and capture-token (Receipt capture) into the same file. Render both Cards stacked:

```tsx
// frontend/src/pages/settings/tabs/ImportsTab.tsx
import { useEffect, useState } from 'react'
import { Card } from '@/components/ui/card'

export function ImportsTab() {
  // Import receipts state + handlers
  // Receipt capture state + handlers

  return (
    <>
      <Card className="accountsFormCard">
        {/* JSX from 1275-1498 */}
      </Card>
      <Card className="accountsFormCard">
        {/* JSX from 1769-1862 */}
      </Card>
    </>
  )
}
```

The two cards' state pools don't overlap in the source — verify with grep before pasting.

- [ ] **Step 5: Run tests to verify pass**

Run: `cd frontend && yarn vitest run src/pages/settings/tabs/ImportsTab.test.tsx`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/pages/settings/tabs/ImportsTab.tsx \
        frontend/src/pages/settings/tabs/ImportsTab.test.tsx
git commit -m "feat(settings): extract ImportsTab (Import receipts + Receipt capture)"
```

---

### Task 10: Extract `EnrichmentTab.tsx` (combines dashboard + maintenance)

**Files:**
- Create: `frontend/src/pages/settings/tabs/EnrichmentTab.tsx`
- Create: `frontend/src/pages/settings/tabs/EnrichmentTab.test.tsx`
- Reference: `frontend/src/pages/SettingsPage.tsx:1499-1627` (maintenance) + `1628-1752` (dashboard)

- [ ] **Step 1: Find dependencies**

Run:

```bash
grep -n "backfill\|stats\|statsError\|statsLoading\|EnrichmentBackfillProgress\|EnrichmentStats\|BackfillSummary\|BackfillProgressRow\|BackfillErrorEvent" frontend/src/pages/SettingsPage.tsx | head -40
```

Also lift the type aliases at lines 81–83 (`BackfillSummary`, `BackfillProgressRow`, `BackfillErrorEvent`) into this file.

- [ ] **Step 2: Write the failing test**

```tsx
// frontend/src/pages/settings/tabs/EnrichmentTab.test.tsx
import { render, screen } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { EnrichmentTab } from './EnrichmentTab'

vi.stubGlobal('fetch', vi.fn(() =>
  Promise.resolve({ ok: true, json: () => Promise.resolve({}) } as Response),
))

describe('EnrichmentTab', () => {
  it('renders Enrichment maintenance and dashboard headings', () => {
    render(<EnrichmentTab />)
    expect(screen.getByRole('heading', { name: /enrichment maintenance/i })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: /enrichment dashboard/i })).toBeInTheDocument()
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd frontend && yarn vitest run src/pages/settings/tabs/EnrichmentTab.test.tsx`
Expected: FAIL.

- [ ] **Step 4: Extract**

Same pattern as Task 9. Stack maintenance then dashboard (matches source order). Place maintenance JSX first (it's higher in the source — line 1499 vs 1628).

```tsx
// frontend/src/pages/settings/tabs/EnrichmentTab.tsx
import { useEffect, useState } from 'react'
import { Card } from '@/components/ui/card'
import type { EnrichmentBackfillProgress, EnrichmentStats } from '../../../types/api'

type BackfillSummary = Extract<EnrichmentBackfillProgress, { kind: 'summary' }>
type BackfillProgressRow = Extract<EnrichmentBackfillProgress, { kind: 'progress' }>
type BackfillErrorEvent = Extract<EnrichmentBackfillProgress, { kind: 'error' }>

export function EnrichmentTab() {
  // backfill* state + handlers
  // stats* state + handlers

  return (
    <>
      <Card className="accountsFormCard">
        {/* maintenance JSX from 1499-1627 */}
      </Card>
      <Card className="accountsFormCard">
        {/* dashboard JSX from 1628-1752 */}
      </Card>
    </>
  )
}
```

- [ ] **Step 5: Run tests to verify pass**

Run: `cd frontend && yarn vitest run src/pages/settings/tabs/EnrichmentTab.test.tsx`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/pages/settings/tabs/EnrichmentTab.tsx \
        frontend/src/pages/settings/tabs/EnrichmentTab.test.tsx
git commit -m "feat(settings): extract EnrichmentTab (maintenance + dashboard)"
```

---

### Task 11: Wire up nested routes in `App.tsx`

**Files:**
- Modify: `frontend/src/App.tsx`

- [ ] **Step 1: Update the imports**

Read `frontend/src/App.tsx` to find the current `SettingsPage` import (likely around the top of file, near other page imports).

Replace:

```ts
import { SettingsPage } from './pages/SettingsPage'
```

with:

```ts
import { SettingsPage } from './pages/settings/SettingsPage'
import { SettingsTabLayout } from './pages/settings/SettingsTabLayout'
import { DisplaySection } from './pages/settings/sections/DisplaySection'
import { GmailSection } from './pages/settings/sections/GmailSection'
import { PartnerInviteSection } from './pages/settings/sections/PartnerInviteSection'
import { ImportsTab } from './pages/settings/tabs/ImportsTab'
import { EnrichmentTab } from './pages/settings/tabs/EnrichmentTab'
import { ContactsTab } from './pages/settings/tabs/ContactsTab'
import { BudgetsTab } from './pages/settings/tabs/BudgetsTab'
```

The default `SettingsPage` import path adjustment: if the original was `import { SettingsPage } from './pages/SettingsPage'`, the new path keeps the same named export but points to the new file. Both files briefly coexist (the old one becomes unused) until Task 12 deletes it.

- [ ] **Step 2: Replace the route**

Read the current route block around the line `<Route path="settings" element={<SettingsPage />} />` (App.tsx:45).

Replace:

```tsx
<Route path="settings" element={<SettingsPage />} />
```

with:

```tsx
<Route path="settings" element={<SettingsPage />}>
  <Route index element={<Navigate to="display" replace />} />
  <Route element={<SettingsTabLayout />}>
    <Route path="display" element={<DisplaySection />} />
    <Route path="gmail" element={<GmailSection />} />
    <Route path="partner-invite" element={<PartnerInviteSection />} />
  </Route>
  <Route path="imports" element={<ImportsTab />} />
  <Route path="enrichment" element={<EnrichmentTab />} />
  <Route path="contacts" element={<ContactsTab />} />
  <Route path="budgets" element={<BudgetsTab />} />
</Route>
```

`Navigate` is already imported at the top of App.tsx (used for the catch-all redirect at line 46).

- [ ] **Step 3: Run the full app smoke test**

Run: `cd frontend && yarn dev` in one terminal, then in a browser visit:
- `http://localhost:5173/settings` → should redirect to `/settings/display`, show Display section with Display radios.
- Click each top tab; URL updates and content swaps.
- Click each left sidebar link inside Settings tab; sub-route URL updates and section content swaps.
- Refresh on `/settings/contacts`; you stay there.
- Browser back from `/settings/budgets` after navigating from `/settings/imports`; lands back on imports.

If any tab shows missing UI vs. the old page, that section's extraction (Tasks 4–10) missed a hook or handler — fix the extraction in that section's file before proceeding.

- [ ] **Step 4: Run the full test suite**

Run: `cd frontend && yarn test`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/App.tsx
git commit -m "feat(settings): wire nested routes for new settings tree"
```

---

### Task 12: Delete old `SettingsPage.tsx`

**Files:**
- Delete: `frontend/src/pages/SettingsPage.tsx`

- [ ] **Step 1: Confirm no other file imports the old path**

Run:

```bash
grep -rn "from './pages/SettingsPage'\|from '../pages/SettingsPage'\|from '@/pages/SettingsPage'" frontend/src/
```

Expected: zero matches. If anything matches, fix it before deleting.

- [ ] **Step 2: Delete the file**

```bash
git rm frontend/src/pages/SettingsPage.tsx
```

- [ ] **Step 3: Verify build + tests**

Run:

```bash
cd frontend && yarn build && yarn test
```

Expected: build succeeds, all tests pass.

- [ ] **Step 4: Commit**

```bash
git commit -m "chore(settings): delete old monolithic SettingsPage"
```

---

### Task 13: Integration smoke test for tab navigation

**Files:**
- Create: `frontend/src/pages/settings/settings-routing.integration.test.tsx`

- [ ] **Step 1: Write the integration test**

```tsx
// frontend/src/pages/settings/settings-routing.integration.test.tsx
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes, Navigate } from 'react-router-dom'
import { describe, it, expect, vi } from 'vitest'
import { SettingsPage } from './SettingsPage'
import { SettingsTabLayout } from './SettingsTabLayout'
import { DisplaySection } from './sections/DisplaySection'
import { GmailSection } from './sections/GmailSection'
import { PartnerInviteSection } from './sections/PartnerInviteSection'
import { ImportsTab } from './tabs/ImportsTab'
import { EnrichmentTab } from './tabs/EnrichmentTab'
import { ContactsTab } from './tabs/ContactsTab'
import { BudgetsTab } from './tabs/BudgetsTab'

vi.mock('../../lib/useAuth', () => ({
  useAuth: () => ({
    user: { household: { name: 'Test HH' }, email: 't@x.io', globalRole: null },
  }),
}))

vi.stubGlobal('fetch', vi.fn(() =>
  Promise.resolve({ ok: true, json: () => Promise.resolve({}) } as Response),
))

function renderApp(initialPath: string) {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Routes>
        <Route path="/settings" element={<SettingsPage />}>
          <Route index element={<Navigate to="display" replace />} />
          <Route element={<SettingsTabLayout />}>
            <Route path="display" element={<DisplaySection />} />
            <Route path="gmail" element={<GmailSection />} />
            <Route path="partner-invite" element={<PartnerInviteSection />} />
          </Route>
          <Route path="imports" element={<ImportsTab />} />
          <Route path="enrichment" element={<EnrichmentTab />} />
          <Route path="contacts" element={<ContactsTab />} />
          <Route path="budgets" element={<BudgetsTab />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  )
}

describe('settings routing', () => {
  it('/settings redirects to /settings/display', () => {
    renderApp('/settings')
    expect(screen.getByRole('heading', { name: /display width/i })).toBeInTheDocument()
  })

  it('clicking the Contacts top tab navigates to contacts', async () => {
    renderApp('/settings/display')
    await userEvent.click(screen.getByRole('tab', { name: 'Contacts' }))
    expect(screen.getByRole('heading', { name: /contacts ledger/i })).toBeInTheDocument()
  })

  it('clicking the Gmail sidebar link inside Settings tab swaps section', async () => {
    renderApp('/settings/display')
    await userEvent.click(screen.getByRole('link', { name: 'Gmail' }))
    expect(screen.getByRole('heading', { name: /connect gmail/i })).toBeInTheDocument()
  })

  it('left sidebar disappears outside Settings tab', () => {
    renderApp('/settings/contacts')
    expect(screen.queryByRole('link', { name: 'Display' })).not.toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run the integration tests**

Run: `cd frontend && yarn vitest run src/pages/settings/settings-routing.integration.test.tsx`
Expected: PASS (4 cases).

- [ ] **Step 3: Run the full test suite**

Run: `cd frontend && yarn test`
Expected: all tests pass.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/pages/settings/settings-routing.integration.test.tsx
git commit -m "test(settings): integration test for tab + sidebar navigation"
```

---

### Task 14: Verify manually in the browser

**Files:** none (verification only)

- [ ] **Step 1: Start the dev server**

Run: `cd frontend && yarn dev`

- [ ] **Step 2: Walk through every tab + sidebar item**

Open `http://localhost:5173/settings` and verify each surface matches the pre-refactor behavior:

| URL | What you should see |
|---|---|
| `/settings` | redirects to `/settings/display`, shows Display radio buttons |
| `/settings/display` | Display section, Settings tab active, Display sidebar link active |
| `/settings/gmail` | Gmail section with OAuth + scan + allowlist controls, Settings tab + Gmail link active |
| `/settings/partner-invite` | Partner invite section, Settings tab + Partner invite link active |
| `/settings/imports` | Two stacked cards: Import receipts then Receipt capture |
| `/settings/enrichment` | Two stacked cards: Enrichment maintenance then Enrichment dashboard |
| `/settings/contacts` | Contacts ledger with form + grid |
| `/settings/budgets` | Monthly budgets form + table |

For each surface, verify a primary interaction still works:

- Display: changing the radio updates the layout width (visible immediately).
- Gmail: "Connect Gmail" button is clickable (don't OAuth — just that it triggers the request).
- Partner invite: "Generate invite link" or equivalent CTA renders a URL.
- Imports: paste a single line of receipt text, hit submit, see response.
- Enrichment: dry-run backfill button starts the SSE feed (cancel immediately, just confirm it begins).
- Contacts: add a contact via the form; it appears in the grid.
- Budgets: add a budget; it appears in the table.

If any interaction fails, the section's extraction missed something. Identify which section, open that file, compare against the source line range, and add the missing piece.

- [ ] **Step 2.5: Mobile check**

Resize the window to ≤768px wide.
- The top tabs should remain horizontally scrollable (no wrapping into a second row that overlaps content).
- Inside the Settings tab, the left sidebar should stack above the section content as a horizontal pill row.
If either is broken, revisit the CSS added in Task 3 Step 4.

- [ ] **Step 3: No commit needed**

This task only verifies behavior. No code change.

---

## Final verification

After all tasks:

- [ ] `frontend/src/pages/SettingsPage.tsx` no longer exists.
- [ ] `frontend/src/pages/settings/SettingsPage.tsx` is under 100 lines.
- [ ] `yarn build` succeeds.
- [ ] `yarn test` passes.
- [ ] Manual walkthrough in Task 14 passes.
- [ ] `git log --oneline` shows ~13 commits, one per task that produced code.

## Notes for the implementing engineer

- **Avoid renaming during extraction.** Keep state variable names, handler names, CSS class names identical to the source. Renames belong in a separate change.
- **Don't merge logic across sections.** Imports tab renders two cards independently — don't try to unify `receiptError` and capture-token error state into one. The spec is explicit: behavior preserved verbatim.
- **If a state variable is shared between two sections in the source** (e.g., a generic `err`/`setErr` used by multiple Cards): scope a separate instance per section file. The two error states aren't related; sharing was incidental.
- **`useAuth`, `useToast`** and other hooks called once at the top of the monolith: if a section uses them, the section calls them itself.
- **Watch for `useEffect` dependency arrays.** When you move an effect, every variable in its dep array must exist in the new component's scope.
- **No backend changes.** Every API call, request shape, and response handling moves byte-identical.
