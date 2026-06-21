# Settings Nav Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Settings page's two horizontal tab strips + Settings-only sub-nav with one vertical grouped sidebar, relocate Budgets/Enrichment to the global nav, merge Palette+DesignSystem and the two token pages, and kill the dead Notifications tab.

**Architecture:** Frontend only. A new `SettingsSidebar` (route-based `NavLink` list, three groups) renders inside the `SettingsPage` shell; all settings routes flatten into the shell's `<Outlet>`. The old `SettingsTabLayout` and `useActiveSettingsTopTab` are deleted (NavLink owns active state). Old paths get `<Navigate replace>` redirects. Two merged pages compose existing components untouched.

**Tech Stack:** React 19, react-router-dom v7, Tailwind v4, vitest + @testing-library/react, lucide-react icons.

## Global Constraints

- Frontend only — no backend, API, or data-model changes.
- Preserve all section behavior verbatim; merges compose existing components, no logic rewrites.
- Prefer Tailwind utilities over raw `App.css` (project rule). Add no new App.css; remove dead rules.
- Every old path must redirect (no blank Outlet / 404): `/settings/palette`, `/settings/design-system` → `/settings/appearance`; `/settings/audit-tokens`, `/settings/reporting-tokens` → `/settings/api-tokens`; `/settings/budgets` → `/budgets`; `/settings/enrichment` → `/enrichment`.
- Feedback stays owner-only (`household.role === 'owner' || globalRole === 'superadmin'`); make gating visible (locked item), do not change who can access.
- Run frontend tests with `yarn workspace frontend run test <file>` from repo root.

---

### Task 1: `SettingsSidebar` component

**Files:**
- Create: `frontend/src/pages/settings/SettingsSidebar.tsx`
- Test: `frontend/src/pages/settings/SettingsSidebar.test.tsx`

**Interfaces:**
- Consumes: `useAuth` from `../../lib/useAuth` (shape: `auth.user?.household?.role`, `auth.user?.globalRole`).
- Produces: `export function SettingsSidebar(): JSX.Element` — a `<nav aria-label="Settings sections">` of three groups (Configuration / Library / Advanced). Items are `NavLink`s except owner-only Feedback, which for non-owners renders a disabled `<span aria-disabled="true" title="Owner only">` with a lock icon.

- [ ] **Step 1: Write the failing test**

```tsx
// frontend/src/pages/settings/SettingsSidebar.test.tsx
import React from 'react'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, it, expect, vi } from 'vitest'
import { SettingsSidebar } from './SettingsSidebar'

const mockUseAuth = vi.fn()
vi.mock('../../lib/useAuth', () => ({ useAuth: () => mockUseAuth() }))

function renderSidebar(path = '/settings/display') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <SettingsSidebar />
    </MemoryRouter>,
  )
}

describe('SettingsSidebar', () => {
  it('renders the three group headers', () => {
    mockUseAuth.mockReturnValue({ user: { household: { role: 'member' }, globalRole: null } })
    renderSidebar()
    expect(screen.getByText('Configuration')).toBeInTheDocument()
    expect(screen.getByText('Library')).toBeInTheDocument()
    expect(screen.getByText('Advanced')).toBeInTheDocument()
  })

  it('renders Appearance and API tokens links (merged destinations)', () => {
    mockUseAuth.mockReturnValue({ user: { household: { role: 'member' }, globalRole: null } })
    renderSidebar()
    expect(screen.getByRole('link', { name: 'Appearance' })).toHaveAttribute('href', '/settings/appearance')
    expect(screen.getByRole('link', { name: 'API tokens' })).toHaveAttribute('href', '/settings/api-tokens')
  })

  it('does NOT render Budgets, Enrichment, or Notifications (moved/removed)', () => {
    mockUseAuth.mockReturnValue({ user: { household: { role: 'owner' }, globalRole: null } })
    renderSidebar()
    expect(screen.queryByRole('link', { name: 'Budgets' })).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Enrichment' })).not.toBeInTheDocument()
    expect(screen.queryByText('Notifications')).not.toBeInTheDocument()
  })

  it('renders Feedback as a real link for owners', () => {
    mockUseAuth.mockReturnValue({ user: { household: { role: 'owner' }, globalRole: null } })
    renderSidebar()
    expect(screen.getByRole('link', { name: 'Feedback' })).toBeInTheDocument()
  })

  it('renders Feedback locked (not a link) for non-owners', () => {
    mockUseAuth.mockReturnValue({ user: { household: { role: 'member' }, globalRole: null } })
    renderSidebar()
    expect(screen.queryByRole('link', { name: /Feedback/ })).not.toBeInTheDocument()
    const locked = screen.getByText('Feedback')
    expect(locked.closest('[aria-disabled="true"]')).not.toBeNull()
  })

  it('treats superadmin as owner for Feedback', () => {
    mockUseAuth.mockReturnValue({ user: { household: { role: 'member' }, globalRole: 'superadmin' } })
    renderSidebar()
    expect(screen.getByRole('link', { name: 'Feedback' })).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn workspace frontend run test SettingsSidebar`
Expected: FAIL — cannot resolve `./SettingsSidebar`.

- [ ] **Step 3: Write minimal implementation**

```tsx
// frontend/src/pages/settings/SettingsSidebar.tsx
import { NavLink } from 'react-router-dom'
import { Lock } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useAuth } from '../../lib/useAuth'

type SettingsNavItem = { to: string; label: string; ownerOnly?: boolean }
type SettingsNavGroup = { id: string; label: string; items: SettingsNavItem[] }

const GROUPS: SettingsNavGroup[] = [
  {
    id: 'configuration',
    label: 'Configuration',
    items: [
      { to: '/settings/display', label: 'Display' },
      { to: '/settings/appearance', label: 'Appearance' },
      { to: '/settings/gmail', label: 'Gmail' },
      { to: '/settings/partner-invite', label: 'Partner invite' },
      { to: '/settings/members', label: 'Members' },
    ],
  },
  {
    id: 'library',
    label: 'Library',
    items: [
      { to: '/settings/categories', label: 'Categories' },
      { to: '/settings/labels', label: 'Labels' },
      { to: '/settings/contacts', label: 'Contacts' },
      { to: '/settings/saved-filters', label: 'Saved filters' },
    ],
  },
  {
    id: 'advanced',
    label: 'Advanced',
    items: [
      { to: '/settings/imports', label: 'Imports' },
      { to: '/settings/jobs', label: 'Jobs' },
      { to: '/settings/api-tokens', label: 'API tokens' },
      { to: '/settings/audit-log', label: 'Audit log' },
      { to: '/settings/backup', label: 'Backup & export' },
      { to: '/settings/feedback', label: 'Feedback', ownerOnly: true },
      { to: '/settings/whatsnew', label: "What's new" },
    ],
  },
]

const linkBase = 'flex items-center justify-between rounded-md px-3 py-1.5 text-sm transition-colors'

export function SettingsSidebar() {
  const auth = useAuth()
  const isOwner =
    auth.user?.household?.role === 'owner' || auth.user?.globalRole === 'superadmin'

  return (
    <nav className="flex w-48 shrink-0 flex-col gap-4" aria-label="Settings sections">
      {GROUPS.map((group) => (
        <div key={group.id} className="flex flex-col gap-0.5">
          <span className="px-3 pb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {group.label}
          </span>
          {group.items.map((item) => {
            if (item.ownerOnly && !isOwner) {
              return (
                <span
                  key={item.to}
                  aria-disabled="true"
                  title="Owner only"
                  className={cn(linkBase, 'cursor-not-allowed text-muted-foreground/60')}
                >
                  {item.label}
                  <Lock aria-hidden="true" className="size-3.5" />
                </span>
              )
            }
            return (
              <NavLink
                key={item.to}
                to={item.to}
                className={({ isActive }) =>
                  cn(
                    linkBase,
                    isActive
                      ? 'bg-card font-medium text-foreground shadow-sm'
                      : 'text-muted-foreground hover:text-foreground',
                  )
                }
              >
                {item.label}
              </NavLink>
            )
          })}
        </div>
      ))}
    </nav>
  )
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn workspace frontend run test SettingsSidebar`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/pages/settings/SettingsSidebar.tsx frontend/src/pages/settings/SettingsSidebar.test.tsx
git commit -m "feat(settings): add grouped vertical SettingsSidebar"
```

---

### Task 2: `AppearanceSection` (merge Palette + Design System)

**Files:**
- Create: `frontend/src/pages/settings/sections/AppearanceSection.tsx`
- Test: `frontend/src/pages/settings/sections/AppearanceSection.test.tsx`

**Interfaces:**
- Consumes: existing `PaletteSection` and `DesignSystemSection` from the same dir (rendered untouched).
- Produces: `export function AppearanceSection(): JSX.Element` — both sections stacked.

- [ ] **Step 1: Write the failing test**

```tsx
// frontend/src/pages/settings/sections/AppearanceSection.test.tsx
import React from 'react'
import { render, screen } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { AppearanceSection } from './AppearanceSection'

vi.mock('./PaletteSection', () => ({ PaletteSection: () => <div>palette-marker</div> }))
vi.mock('./DesignSystemSection', () => ({ DesignSystemSection: () => <div>design-system-marker</div> }))

describe('AppearanceSection', () => {
  it('renders both the palette and design-system sections', () => {
    render(<AppearanceSection />)
    expect(screen.getByText('palette-marker')).toBeInTheDocument()
    expect(screen.getByText('design-system-marker')).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn workspace frontend run test AppearanceSection`
Expected: FAIL — cannot resolve `./AppearanceSection`.

- [ ] **Step 3: Write minimal implementation**

```tsx
// frontend/src/pages/settings/sections/AppearanceSection.tsx
import { PaletteSection } from './PaletteSection'
import { DesignSystemSection } from './DesignSystemSection'

export function AppearanceSection() {
  return (
    <div className="flex flex-col gap-8">
      <PaletteSection />
      <DesignSystemSection />
    </div>
  )
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn workspace frontend run test AppearanceSection`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/pages/settings/sections/AppearanceSection.tsx frontend/src/pages/settings/sections/AppearanceSection.test.tsx
git commit -m "feat(settings): merge Palette + Design System into AppearanceSection"
```

---

### Task 3: `ApiTokensTab` (merge AI audit + Reporting tokens)

**Files:**
- Create: `frontend/src/pages/settings/tabs/ApiTokensTab.tsx`
- Test: `frontend/src/pages/settings/tabs/ApiTokensTab.test.tsx`

**Interfaces:**
- Consumes: existing `AuditTokensTab` and `ReportingTokensTab` from the same dir (rendered untouched).
- Produces: `export function ApiTokensTab(): JSX.Element` — both stacked.

- [ ] **Step 1: Write the failing test**

```tsx
// frontend/src/pages/settings/tabs/ApiTokensTab.test.tsx
import React from 'react'
import { render, screen } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { ApiTokensTab } from './ApiTokensTab'

vi.mock('./AuditTokensTab', () => ({ AuditTokensTab: () => <div>audit-tokens-marker</div> }))
vi.mock('./ReportingTokensTab', () => ({ ReportingTokensTab: () => <div>reporting-tokens-marker</div> }))

describe('ApiTokensTab', () => {
  it('renders both the audit-tokens and reporting-tokens sections', () => {
    render(<ApiTokensTab />)
    expect(screen.getByText('audit-tokens-marker')).toBeInTheDocument()
    expect(screen.getByText('reporting-tokens-marker')).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn workspace frontend run test ApiTokensTab`
Expected: FAIL — cannot resolve `./ApiTokensTab`.

- [ ] **Step 3: Write minimal implementation**

```tsx
// frontend/src/pages/settings/tabs/ApiTokensTab.tsx
import { AuditTokensTab } from './AuditTokensTab'
import { ReportingTokensTab } from './ReportingTokensTab'

export function ApiTokensTab() {
  return (
    <div className="flex flex-col gap-8">
      <AuditTokensTab />
      <ReportingTokensTab />
    </div>
  )
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn workspace frontend run test ApiTokensTab`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/pages/settings/tabs/ApiTokensTab.tsx frontend/src/pages/settings/tabs/ApiTokensTab.test.tsx
git commit -m "feat(settings): merge token pages into ApiTokensTab"
```

---

### Task 4: Cutover — shell, routes, redirects, deletions

This is the atomic switch: `SettingsPage` adopts `SettingsSidebar`, `App.tsx` flattens settings routes + adds redirects + relocates Budgets/Enrichment, dead files are deleted, the stale dashboard link is fixed, and the two affected test files are rewritten. It must land together.

**Files:**
- Modify: `frontend/src/pages/settings/SettingsPage.tsx` (full rewrite of shell)
- Modify: `frontend/src/App.tsx:173-197` (settings route block) + imports near `:46-64` + add two top-level routes
- Modify: `frontend/src/components/dashboard/BudgetStatusCard.tsx:82` (`/settings/budgets` → `/budgets`)
- Delete: `frontend/src/pages/settings/SettingsTabLayout.tsx`, `frontend/src/pages/settings/SettingsTabLayout.test.tsx`
- Delete: `frontend/src/pages/settings/useActiveSettingsTopTab.ts`, `frontend/src/pages/settings/useActiveSettingsTopTab.test.tsx`
- Rewrite: `frontend/src/pages/settings/SettingsPage.test.tsx`
- Rewrite: `frontend/src/pages/settings/settings-routing.integration.test.tsx`
- Modify: `frontend/src/App.css` (remove dead `.settingsTopTabs`, `.settingsTabLayout*`, `.settingsSubnav*` rules)

**Interfaces:**
- Consumes: `SettingsSidebar` (Task 1), `AppearanceSection` (Task 2), `ApiTokensTab` (Task 3).
- Produces: settings route tree — `display, appearance, gmail, partner-invite, members, categories, labels, contacts, saved-filters, imports, jobs, api-tokens, audit-log, backup, feedback, whatsnew` as direct children of `/settings`; redirects for `palette, design-system, audit-tokens, reporting-tokens, budgets, enrichment`; top-level `/budgets` (`BudgetsTab`) and `/enrichment` (`EnrichmentTab`).

- [ ] **Step 1: Rewrite the SettingsPage shell test (failing)**

Replace the entire contents of `frontend/src/pages/settings/SettingsPage.test.tsx`:

```tsx
import React from 'react'
import { render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { describe, it, expect, vi } from 'vitest'
import { SettingsPage } from './SettingsPage'

vi.mock('../../lib/useAuth', () => ({
  useAuth: () => ({
    user: { household: { name: 'Test HH', role: 'owner' }, email: 't@x.io', globalRole: null },
  }),
}))

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/settings" element={<SettingsPage />}>
          <Route path="display" element={<div>display-marker</div>} />
          <Route path="categories" element={<div>categories-marker</div>} />
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

  it('renders the sidebar with grouped sections', () => {
    renderAt('/settings/display')
    expect(screen.getByRole('navigation', { name: 'Settings sections' })).toBeInTheDocument()
    expect(screen.getByText('Configuration')).toBeInTheDocument()
    expect(screen.getByText('Library')).toBeInTheDocument()
    expect(screen.getByText('Advanced')).toBeInTheDocument()
  })

  it('renders child outlet content', () => {
    renderAt('/settings/categories')
    expect(screen.getByText('categories-marker')).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn workspace frontend run test SettingsPage`
Expected: FAIL — old `SettingsPage` still renders `role="tablist"`, no `navigation` named "Settings sections".

- [ ] **Step 3: Rewrite the SettingsPage shell**

Replace the entire contents of `frontend/src/pages/settings/SettingsPage.tsx`:

```tsx
import { Outlet } from 'react-router-dom'
import { PageHeader } from '@/components/ui/page-header'
import { useAuth } from '../../lib/useAuth'
import { SettingsSidebar } from './SettingsSidebar'

export function SettingsPage() {
  const auth = useAuth()
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
      <div className="flex gap-6">
        <SettingsSidebar />
        <div className="min-w-0 flex-1">
          <Outlet />
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 4: Run the shell test to verify it passes**

Run: `yarn workspace frontend run test SettingsPage`
Expected: PASS (3 tests).

- [ ] **Step 5: Update App.tsx imports**

In `frontend/src/App.tsx`, within the settings import block (`:46-64`):
- **Remove** the imports for `SettingsTabLayout`, `PaletteSection`, `DesignSystemSection`, `AuditTokensTab`, `ReportingTokensTab`.
- **Add**:

```tsx
import { AppearanceSection } from './pages/settings/sections/AppearanceSection'
import { ApiTokensTab } from './pages/settings/tabs/ApiTokensTab'
```

(Keep `DisplaySection`, `GmailSection`, `PartnerInviteSection`, `ImportsTab`, `EnrichmentTab`, `ContactsTab`, `MembersTab`, `BudgetsTab`, `CategoriesTab`, `LabelsTab`, `SavedFiltersTab`, `JobsTab`, `WhatsNewTab`, `FeedbackInboxTab`, `AuditLogPage`, `SyncPage`.)

- [ ] **Step 6: Replace the settings route block + relocate Budgets/Enrichment**

In `frontend/src/App.tsx`, replace the `<Route path="settings" …>` block (`:173-197`) with:

```tsx
          <Route path="settings" element={<SettingsPage />}>
            <Route index element={<Navigate to="display" replace />} />
            <Route path="display" element={<DisplaySection />} />
            <Route path="appearance" element={<AppearanceSection />} />
            <Route path="gmail" element={<GmailSection />} />
            <Route path="partner-invite" element={<PartnerInviteSection />} />
            <Route path="members" element={<MembersTab />} />
            <Route path="categories" element={<CategoriesTab />} />
            <Route path="labels" element={<LabelsTab />} />
            <Route path="contacts" element={<ContactsTab />} />
            <Route path="saved-filters" element={<SavedFiltersTab />} />
            <Route path="imports" element={<ImportsTab />} />
            <Route path="jobs" element={<JobsTab />} />
            <Route path="api-tokens" element={<ApiTokensTab />} />
            <Route path="audit-log" element={<AuditLogPage />} />
            <Route path="backup" element={<SyncPage />} />
            <Route path="feedback" element={<FeedbackInboxTab />} />
            <Route path="whatsnew" element={<WhatsNewTab />} />
            {/* Folded/moved routes — redirect old deep links */}
            <Route path="palette" element={<Navigate to="/settings/appearance" replace />} />
            <Route path="design-system" element={<Navigate to="/settings/appearance" replace />} />
            <Route path="audit-tokens" element={<Navigate to="/settings/api-tokens" replace />} />
            <Route path="reporting-tokens" element={<Navigate to="/settings/api-tokens" replace />} />
            <Route path="budgets" element={<Navigate to="/budgets" replace />} />
            <Route path="enrichment" element={<Navigate to="/enrichment" replace />} />
          </Route>
          {/* Relocated out of Settings (issue: settings junk-drawer) */}
          <Route path="budgets" element={<BudgetsTab />} />
          <Route path="enrichment" element={<EnrichmentTab />} />
```

- [ ] **Step 7: Fix the stale dashboard link**

In `frontend/src/components/dashboard/BudgetStatusCard.tsx:82`, change:

```tsx
            <Link to="/settings/budgets">Set a budget</Link>
```
to:
```tsx
            <Link to="/budgets">Set a budget</Link>
```

- [ ] **Step 8: Delete the dead files**

```bash
git rm frontend/src/pages/settings/SettingsTabLayout.tsx \
       frontend/src/pages/settings/SettingsTabLayout.test.tsx \
       frontend/src/pages/settings/useActiveSettingsTopTab.ts \
       frontend/src/pages/settings/useActiveSettingsTopTab.test.tsx
```

- [ ] **Step 9: Rewrite the routing integration test**

Replace the entire contents of `frontend/src/pages/settings/settings-routing.integration.test.tsx`:

```tsx
import React from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes, Navigate } from 'react-router-dom'
import { describe, it, expect, vi } from 'vitest'
import { SettingsPage } from './SettingsPage'
import { DisplaySection } from './sections/DisplaySection'
import { ContactsTab } from './tabs/ContactsTab'

vi.mock('../../lib/useAuth', () => ({
  useAuth: () => ({
    user: { household: { name: 'Test HH', role: 'owner' }, email: 't@x.io', globalRole: null },
  }),
}))

vi.stubGlobal(
  'fetch',
  vi.fn((input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString()
    const body = url.includes('/api/contacts') ? [] : {}
    return Promise.resolve({ ok: true, json: () => Promise.resolve(body) } as Response)
  }),
)

function renderApp(initialPath: string) {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Routes>
        <Route path="/settings" element={<SettingsPage />}>
          <Route index element={<Navigate to="display" replace />} />
          <Route path="display" element={<DisplaySection />} />
          <Route path="contacts" element={<ContactsTab />} />
          <Route path="appearance" element={<div>appearance-marker</div>} />
          <Route path="api-tokens" element={<div>api-tokens-marker</div>} />
          <Route path="palette" element={<Navigate to="/settings/appearance" replace />} />
          <Route path="design-system" element={<Navigate to="/settings/appearance" replace />} />
          <Route path="audit-tokens" element={<Navigate to="/settings/api-tokens" replace />} />
          <Route path="reporting-tokens" element={<Navigate to="/settings/api-tokens" replace />} />
          <Route path="budgets" element={<Navigate to="/budgets" replace />} />
          <Route path="enrichment" element={<Navigate to="/enrichment" replace />} />
        </Route>
        <Route path="/budgets" element={<div>budgets-page-marker</div>} />
        <Route path="/enrichment" element={<div>enrichment-page-marker</div>} />
      </Routes>
    </MemoryRouter>,
  )
}

describe('settings routing', () => {
  it('/settings redirects to /settings/display', () => {
    renderApp('/settings')
    expect(screen.getByRole('heading', { name: /display width/i })).toBeInTheDocument()
  })

  it('clicking a sidebar link navigates within settings', async () => {
    renderApp('/settings/display')
    await userEvent.click(screen.getByRole('link', { name: 'Contacts' }))
    expect(screen.getByRole('heading', { name: /contacts ledger/i })).toBeInTheDocument()
  })

  it.each([
    ['/settings/palette', 'appearance-marker'],
    ['/settings/design-system', 'appearance-marker'],
    ['/settings/audit-tokens', 'api-tokens-marker'],
    ['/settings/reporting-tokens', 'api-tokens-marker'],
  ])('%s redirects to its merged page', (path, marker) => {
    renderApp(path)
    expect(screen.getByText(marker)).toBeInTheDocument()
  })

  it.each([
    ['/settings/budgets', 'budgets-page-marker'],
    ['/settings/enrichment', 'enrichment-page-marker'],
  ])('%s redirects out of settings', (path, marker) => {
    renderApp(path)
    expect(screen.getByText(marker)).toBeInTheDocument()
  })
})
```

> Note: `DisplaySection` renders a heading matching `/display width/i` and `ContactsTab` one matching `/contacts ledger/i` (both relied on by the pre-existing test). If either heading text has changed, adjust the matcher to the current text.

- [ ] **Step 10: Remove dead CSS**

Find the dead rules: `grep -nE '\.settingsTopTabs|\.settingsTabLayout|\.settingsSubnav' frontend/src/App.css`. Delete each matched rule block (selector + its `{ … }` body, including `--content`, `--link`, `.isActive`, and `__` variants). These classes have no remaining references after this task.

- [ ] **Step 11: Run the affected tests + typecheck**

Run: `yarn workspace frontend run test settings-routing SettingsPage SettingsSidebar`
Expected: PASS.
Run: `yarn workspace frontend run build` (tsc + vite) — Expected: no TS errors about missing `SettingsTabLayout` / `useActiveSettingsTopTab` / removed imports.

- [ ] **Step 12: Commit**

```bash
git add -A frontend/src/App.tsx frontend/src/App.css \
  frontend/src/pages/settings/SettingsPage.tsx frontend/src/pages/settings/SettingsPage.test.tsx \
  frontend/src/pages/settings/settings-routing.integration.test.tsx \
  frontend/src/components/dashboard/BudgetStatusCard.tsx
git commit -m "refactor(settings): vertical sidebar shell, flat routes, redirects, relocate budgets/enrichment"
```

---

### Task 5: Global sidebar — surface Budgets + Enrichment

**Files:**
- Modify: `frontend/src/components/Sidebar.tsx` (icon imports `:3-27`; `planning` items `:76-81`; `insights` items `:93-98`)
- Modify: `frontend/src/components/Sidebar.test.tsx`

**Interfaces:**
- Consumes: relocated routes `/budgets`, `/enrichment` (Task 4).
- Produces: a "Budgets" link under Planning and an "Enrichment" link under Insights & rules.

- [ ] **Step 1: Write the failing test**

Add to `frontend/src/components/Sidebar.test.tsx` (inside the existing top-level `describe`):

```tsx
  it('shows Budgets under Planning and Enrichment under Insights & rules', () => {
    renderSidebar() // use the file's existing render helper
    expect(screen.getByRole('link', { name: /Budgets/ })).toHaveAttribute('href', '/budgets')
    expect(screen.getByRole('link', { name: /Enrichment/ })).toHaveAttribute('href', '/enrichment')
  })
```

> If the existing test file uses a different render helper name or collapses sections by default, mirror that file's setup (it may need the Planning/Insights sections expanded). Match the existing patterns in `Sidebar.test.tsx`.

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn workspace frontend run test Sidebar`
Expected: FAIL — no Budgets/Enrichment links.

- [ ] **Step 3: Add the nav items + icons**

In `frontend/src/components/Sidebar.tsx`, add `PiggyBank` and `Sparkles` to the `lucide-react` import block (`:3-27`).

In the `planning` section items (`:76-81`), add as the first item:

```tsx
      { to: '/budgets', label: 'Budgets', icon: PiggyBank, visibilityKey: 'budgets' },
```

> Check whether a `budgets` key exists on `NavFeature`/`useNavVisibility`. If it does NOT, omit `visibilityKey` (render unconditionally): `{ to: '/budgets', label: 'Budgets', icon: PiggyBank },`.

In the `insights` section items (`:93-98`), add:

```tsx
      { to: '/enrichment', label: 'Enrichment', icon: Sparkles },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn workspace frontend run test Sidebar`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/Sidebar.tsx frontend/src/components/Sidebar.test.tsx
git commit -m "feat(nav): surface Budgets in Planning and Enrichment in Insights"
```

---

### Task 6: Full verification

**Files:** none (verification only).

- [ ] **Step 1: Run the full frontend test suite**

Run: `yarn workspace frontend run test`
Expected: PASS. No references to deleted `SettingsTabLayout` / `useActiveSettingsTopTab`.

- [ ] **Step 2: Typecheck + production build**

Run: `yarn workspace frontend run build`
Expected: clean tsc + vite build.

- [ ] **Step 3: Grep for orphaned references**

```bash
grep -rn "useActiveSettingsTopTab\|SettingsTabLayout\|settings/palette\|settings/design-system\|settings/audit-tokens\|settings/reporting-tokens" frontend/src
```
Expected: no matches in non-test source (redirect `<Route>` entries in `App.tsx` are the only intentional mentions of the old paths). If a stray `Link`/`navigate` to a moved path remains, repoint it (`/settings/budgets`→`/budgets`, `/settings/enrichment`→`/enrichment`, palette/design-system→`/settings/appearance`, token pages→`/settings/api-tokens`).

- [ ] **Step 4: Manual smoke (optional)**

Run `yarn dev`; visit `/settings` (redirects to Display), click each sidebar group item, confirm `/settings/palette` and `/settings/budgets` redirect, confirm Budgets/Enrichment appear in the global left rail.

- [ ] **Step 5: Final commit (if Step 3 required fixes)**

```bash
git add -A && git commit -m "chore(settings): repoint orphaned links after nav cleanup"
```

---

## Self-Review

**Spec coverage:**
- Vertical grouped sidebar replacing two strips + sub-nav → Task 1 + Task 4 (shell). ✓
- Relocate Budgets/Enrichment → Task 4 (routes) + Task 5 (global nav). ✓
- Merge Palette+DesignSystem / token pages → Tasks 2, 3. ✓
- Redirects for all 6 old paths → Task 4 Step 6 + integration test Step 9. ✓
- Kill Notifications → absent from `SettingsSidebar` (Task 1, asserted) and from routes (Task 4); `useActiveSettingsTopTab` (sole holder of the `notifications` key) deleted. ✓
- Relabel "Backup & sync"→"Backup & export" → Task 1 sidebar label. ✓ (the route stays `/settings/backup`.)
- Owner-only Feedback visible lock → Task 1 (tested both roles + superadmin). ✓
- Imports placement (spec gap caught during planning) → Advanced group, Task 1. ✓
- Tailwind-over-CSS rule → sidebar uses utilities; dead CSS removed (Task 4 Step 10). ✓

**Placeholder scan:** No TBD/TODO; every code step has full content. ✓

**Type/name consistency:** `SettingsSidebar`, `AppearanceSection`, `ApiTokensTab` names match across Tasks 1-4. Route paths (`/settings/appearance`, `/settings/api-tokens`, `/budgets`, `/enrichment`) consistent between sidebar links, route defs, redirects, and tests. ✓
