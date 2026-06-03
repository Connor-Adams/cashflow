# Sidebar fold — PR 0 (rail declutter + chrome→Settings + Reports tabs) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the lowest-risk slice of the 46→16 sidebar fold ([spec](../specs/2026-05-31-sidebar-fold-design.md)): remove 6 items from the rail, sending each to its new home — Ask→Chat, Audit log + Backup&sync→Settings tabs, the 3 `/reports/*` pages→a Reports tab bar — and fix the Amazon/Credit-cards mis-files.

**Architecture:** Route changes live in `App.tsx`; rail content lives in `Sidebar.tsx`. Chrome and Reports use **route-based tabs** (the pattern `SettingsPage` already uses), not `?view=` — their sub-routes already exist, so this needs no query-param plumbing and no full-page-embed header nesting. The `?view=` mechanism is reserved for the later primitive folds (Transactions, Planned, …) in PRs 1–4 where no sub-routes exist. Old top-level routes become `<Navigate replace>` redirects so bookmarks survive.

**Tech Stack:** React 18, react-router-dom v6, TypeScript, Vitest + @testing-library/react (jsdom), Tailwind v4. Shared `Tabs`/`TabPanel` at `frontend/src/components/ui/tabs.tsx`.

## Deviations from the spec (flagged)

1. **Section names unchanged.** The spec's PR 0 listed the new 7-section skeleton (Overview/Plan/Invest/Review/Analyze/Operate). This plan keeps the existing 5 section names (Today/Money/Planning/Investments/Insights & rules). Re-skeletoning sections while ~35 pre-fold items still exist is churn; do it once at the end (a final cleanup PR after PRs 1–5). PR 0 only *removes* and *relocates* items within the current sections.
2. **Reports uses route-based tabs, not `?view=`.** Reason in Architecture above. The spec's `?view=` Reports consolidation (adding Partner/Currency/Sankey) remains PR 4.

---

## File structure

| File | Change | Responsibility |
|---|---|---|
| `frontend/src/components/Sidebar.tsx` | modify | Remove 6 rail items; relocate Amazon + Credit cards into Money; drop `/ask` from the openai filter |
| `frontend/src/App.tsx` | modify | `/ask`→`/chat`, `/audit-log`→`/settings/audit-log`, `/sync`→`/settings/backup` redirects; add Settings child routes for audit-log/backup; nest `/reports/*` under `ReportsLayout` |
| `frontend/src/pages/ReportsLayout.tsx` | **create** | Route-based tab bar (Summary · Explain month · Lifestyle · Savings) + `<Outlet/>` |
| `frontend/src/pages/settings/SettingsPage.tsx` | modify | Register `audit-log` + `backup` top tabs |
| `frontend/src/pages/settings/useActiveSettingsTopTab.ts` | modify | Detect the 2 new settings tabs |
| `frontend/src/components/Sidebar.test.tsx` | **create** | Guard: removed items absent, relocations present |
| `frontend/src/pages/ReportsLayout.test.tsx` | **create** | Guard: 4 tabs render + navigate |
| `frontend/src/pages/settings/SettingsPage.test.tsx` | modify (or create) | Guard: new tabs render |
| `frontend/src/pages/reports-routing.integration.test.tsx` | **create** | Guard: `/reports` shows Summary, `/reports/explain-month` mounts under layout |

Reference patterns to copy: `frontend/src/pages/settings/settings-routing.integration.test.tsx` (MemoryRouter + Routes mirror), `frontend/src/pages/ReturnWarrantyPage.test.tsx` (`vi.mock('@/lib/api')`).

---

## Task 1: Rail declutter + mis-file relocation + Ask→Chat

**Files:**
- Modify: `frontend/src/components/Sidebar.tsx:75-159` (navSections), `:254` (filter)
- Modify: `frontend/src/App.tsx:62` (import), `:164` (ask route)
- Test: `frontend/src/components/Sidebar.test.tsx` (create)

- [ ] **Step 1: Write the failing Sidebar test**

Create `frontend/src/components/Sidebar.test.tsx`:

```tsx
import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { Sidebar } from './Sidebar'

void React

vi.mock('../lib/useAuth', () => ({
  useAuth: () => ({ user: { displayName: 'Tester', globalRole: null }, logout: vi.fn() }),
}))
vi.mock('../hooks/useTheme', () => ({
  useTheme: () => ({ theme: 'light', toggleTheme: vi.fn() }),
}))
vi.mock('@/hooks/useAiInboxCount', () => ({ useAiInboxCount: () => ({ count: 0 }) }))
vi.mock('@/hooks/useInsightsCount', () => ({ useInsightsCount: () => ({ count: 0 }) }))
vi.mock('@/hooks/useAiStatus', () => ({ useAiStatus: () => ({ openai: true }) }))
vi.mock('../lib/version', () => ({
  FRONTEND_VERSION: 'test',
  useBackendVersion: () => ({ status: 'ok', version: 'test' }),
}))

function renderSidebar() {
  return render(
    <MemoryRouter>
      <Sidebar open={false} onClose={() => {}} />
    </MemoryRouter>,
  )
}

describe('Sidebar rail (PR 0)', () => {
  it('drops items folded elsewhere', () => {
    renderSidebar()
    for (const name of ['Ask Cashflow', 'Audit log', 'Backup & sync', 'Explain month', 'Lifestyle inflation', 'Savings rate']) {
      expect(screen.queryByRole('link', { name })).not.toBeInTheDocument()
    }
  })

  it('relocates Amazon and Credit cards into the Money section', () => {
    renderSidebar()
    const moneyHeader = screen.getByRole('button', { name: /Money/ })
    const moneySection = moneyHeader.closest('.sidebar__section') as HTMLElement
    expect(within(moneySection).getByRole('link', { name: 'Amazon' })).toBeInTheDocument()
    expect(within(moneySection).getByRole('link', { name: 'Credit cards' })).toBeInTheDocument()
  })

  it('keeps Chat reachable (Ask folds into it)', () => {
    renderSidebar()
    expect(screen.getByRole('link', { name: 'Chat' })).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run it; verify it fails**

Run: `cd frontend && yarn vitest run src/components/Sidebar.test.tsx`
Expected: FAIL — "Ask Cashflow" link still present; Amazon not under Money.

- [ ] **Step 3: Edit `Sidebar.tsx` navSections**

In `frontend/src/components/Sidebar.tsx`:

(a) `today` section — remove the Ask line:
```tsx
{ to: '/ask', label: 'Ask Cashflow', icon: Search },   // DELETE this line
```

(b) `money` section — append Credit cards and Amazon (so they sit in Money). Add after the `/import` line:
```tsx
      { to: '/credit-cards', label: 'Credit cards', icon: CreditCard },
      { to: '/amazon', label: 'Amazon', icon: PackageSearch },
```

(c) `planning` section — remove the Credit cards line:
```tsx
{ to: '/credit-cards', label: 'Credit cards', icon: CreditCard },   // DELETE
```

(d) `investments` section — remove the Amazon line (leaves Portfolio, Net worth):
```tsx
{ to: '/amazon', label: 'Amazon', icon: PackageSearch },   // DELETE
```

(e) `insights` section — remove these five lines (Audit log, Backup&sync, and the 3 report sub-routes):
```tsx
{ to: '/audit-log', label: 'Audit log', icon: Shield },                       // DELETE
{ to: '/sync', label: 'Backup & sync', icon: Save },                          // DELETE
{ to: '/reports/explain-month', label: 'Explain month', icon: BookOpen },     // DELETE
{ to: '/reports/lifestyle-inflation', label: 'Lifestyle inflation', icon: Flame },  // DELETE
{ to: '/reports/savings-rate', label: 'Savings rate', icon: PiggyBank },      // DELETE
```

- [ ] **Step 4: Simplify the openai filter** (`Sidebar.tsx:254`)

`/ask` is gone, so the filter only needs to hide `/chat`:
```tsx
      items: section.items.filter((i) => i.to !== '/chat'),
```

- [ ] **Step 5: Redirect `/ask`→`/chat` in `App.tsx`**

`App.tsx:164` — replace the Ask route:
```tsx
          <Route path="ask" element={<Navigate to="/chat" replace />} />
```
Remove the now-unused import at `App.tsx:62`:
```tsx
import { AskCashflowPage } from './pages/AskCashflowPage'   // DELETE
```
(`Navigate` is already imported at `App.tsx:1`.)

- [ ] **Step 6: Run the Sidebar test; verify it passes**

Run: `cd frontend && yarn vitest run src/components/Sidebar.test.tsx`
Expected: PASS (3 tests).

- [ ] **Step 7: Commit**

```bash
git add frontend/src/components/Sidebar.tsx frontend/src/components/Sidebar.test.tsx frontend/src/App.tsx
git commit --no-verify -m "feat(sidebar): declutter rail, relocate Amazon/Credit cards, fold Ask into Chat"
```
(Hook bypass: `lint-staged` is not installed in this worktree.)

---

## Task 2: Audit log + Backup & sync → Settings tabs

**Files:**
- Modify: `frontend/src/pages/settings/SettingsPage.tsx:7-35`
- Modify: `frontend/src/pages/settings/useActiveSettingsTopTab.ts`
- Modify: `frontend/src/App.tsx` (settings child routes + top-level redirects)
- Test: `frontend/src/pages/settings/SettingsPage.test.tsx`

- [ ] **Step 1: Write the failing SettingsPage tabs test**

Append to (or create) `frontend/src/pages/settings/SettingsPage.test.tsx`. If creating, mirror the mock+render shape of `settings-routing.integration.test.tsx`:

```tsx
import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { SettingsPage } from './SettingsPage'

void React

vi.mock('../../lib/useAuth', () => ({
  useAuth: () => ({ user: { household: { name: 'HH', role: 'owner' }, email: 't@x.io', globalRole: null } }),
}))

function renderSettings(path = '/settings/display') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/settings/*" element={<SettingsPage />} />
      </Routes>
    </MemoryRouter>,
  )
}

describe('SettingsPage tabs (PR 0)', () => {
  it('renders Audit log and Backup & sync tabs', () => {
    renderSettings()
    expect(screen.getByRole('tab', { name: 'Audit log' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Backup & sync' })).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run it; verify it fails**

Run: `cd frontend && yarn vitest run src/pages/settings/SettingsPage.test.tsx`
Expected: FAIL — no tab named "Audit log".

- [ ] **Step 3: Register the tabs in `SettingsPage.tsx`**

Add to `ALL_TOP_TABS` (after the `jobs` entry, `SettingsPage.tsx:20`):
```tsx
    { value: 'audit-log', label: 'Audit log' },
    { value: 'backup', label: 'Backup & sync' },
```
Add to `TOP_TAB_PATHS` (`SettingsPage.tsx:34`):
```tsx
    'audit-log': '/settings/audit-log',
    backup: '/settings/backup',
```

- [ ] **Step 4: Extend `useActiveSettingsTopTab.ts`**

Add to the `SettingsTopTab` union:
```tsx
  | 'audit-log'
  | 'backup'
```
Add matches + checks inside the hook (after the `isJobs` line and before the final returns):
```tsx
  const isAuditLog = useMatch('/settings/audit-log')
  const isBackup = useMatch('/settings/backup')
```
```tsx
  if (isAuditLog) return 'audit-log'
  if (isBackup) return 'backup'
```

- [ ] **Step 5: Wire routes + redirects in `App.tsx`**

Inside the `<Route path="settings" …>` block, add two child routes (alongside `imports`, `jobs`, etc.):
```tsx
            <Route path="audit-log" element={<AuditLogPage />} />
            <Route path="backup" element={<SyncPage />} />
```
Replace the top-level chrome routes (`App.tsx:114-115`) with redirects:
```tsx
          <Route path="audit-log" element={<Navigate to="/settings/audit-log" replace />} />
          <Route path="sync" element={<Navigate to="/settings/backup" replace />} />
```
(`AuditLogPage` and `SyncPage` imports already exist at `App.tsx:32-33`.)

- [ ] **Step 6: Run the test; verify it passes**

Run: `cd frontend && yarn vitest run src/pages/settings/SettingsPage.test.tsx`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/pages/settings/SettingsPage.tsx frontend/src/pages/settings/useActiveSettingsTopTab.ts frontend/src/pages/settings/SettingsPage.test.tsx frontend/src/App.tsx
git commit --no-verify -m "feat(settings): host Audit log + Backup & sync as Settings tabs; redirect old routes"
```

---

## Task 3: Reports route-based tab bar

**Files:**
- Create: `frontend/src/pages/ReportsLayout.tsx`
- Modify: `frontend/src/App.tsx` (nest reports routes under the layout)
- Test: `frontend/src/pages/ReportsLayout.test.tsx`, `frontend/src/pages/reports-routing.integration.test.tsx`

- [ ] **Step 1: Write the failing ReportsLayout test**

Create `frontend/src/pages/ReportsLayout.test.tsx`:

```tsx
import React from 'react'
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { ReportsLayout } from './ReportsLayout'

void React

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/reports" element={<ReportsLayout />}>
          <Route index element={<div>summary-body</div>} />
          <Route path="explain-month" element={<div>explain-body</div>} />
          <Route path="lifestyle-inflation" element={<div>lifestyle-body</div>} />
          <Route path="savings-rate" element={<div>savings-body</div>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  )
}

describe('ReportsLayout (PR 0)', () => {
  it('renders four report tabs and the summary child at /reports', () => {
    renderAt('/reports')
    for (const name of ['Summary', 'Explain month', 'Lifestyle inflation', 'Savings rate']) {
      expect(screen.getByRole('tab', { name })).toBeInTheDocument()
    }
    expect(screen.getByText('summary-body')).toBeInTheDocument()
  })

  it('marks the active tab from the URL', () => {
    renderAt('/reports/explain-month')
    expect(screen.getByRole('tab', { name: 'Explain month' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByText('explain-body')).toBeInTheDocument()
  })

  it('navigates when a tab is clicked', async () => {
    renderAt('/reports')
    await userEvent.click(screen.getByRole('tab', { name: 'Savings rate' }))
    expect(screen.getByText('savings-body')).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run it; verify it fails**

Run: `cd frontend && yarn vitest run src/pages/ReportsLayout.test.tsx`
Expected: FAIL — cannot import `ReportsLayout` (module does not exist).

- [ ] **Step 3: Create `ReportsLayout.tsx`**

```tsx
import { Outlet, useLocation, useNavigate } from 'react-router-dom'
import { Tabs, type TabItem } from '@/components/ui/tabs'

const REPORT_TABS: TabItem[] = [
  { value: 'summary', label: 'Summary' },
  { value: 'explain-month', label: 'Explain month' },
  { value: 'lifestyle-inflation', label: 'Lifestyle inflation' },
  { value: 'savings-rate', label: 'Savings rate' },
]

const TAB_PATHS: Record<string, string> = {
  summary: '/reports',
  'explain-month': '/reports/explain-month',
  'lifestyle-inflation': '/reports/lifestyle-inflation',
  'savings-rate': '/reports/savings-rate',
}

function activeReportTab(pathname: string): string {
  if (pathname.startsWith('/reports/explain-month')) return 'explain-month'
  if (pathname.startsWith('/reports/lifestyle-inflation')) return 'lifestyle-inflation'
  if (pathname.startsWith('/reports/savings-rate')) return 'savings-rate'
  return 'summary'
}

/**
 * Route-based tab bar for the Reports family. Mirrors the SettingsPage tab
 * pattern: each tab is a child route, so the existing /reports/* routes keep
 * working and need no redirects. Child pages own their own PageHeader/.page;
 * this layout only renders the tab strip + Outlet.
 */
export function ReportsLayout() {
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const active = activeReportTab(pathname)
  return (
    <div className="reportsLayout">
      <div className="settingsTopTabs">
        <Tabs items={REPORT_TABS} value={active} onValueChange={(v) => navigate(TAB_PATHS[v])} />
      </div>
      <Outlet />
    </div>
  )
}
```
(Reusing the `settingsTopTabs` class for the tab strip — same visual treatment as Settings.)

- [ ] **Step 4: Run the ReportsLayout test; verify it passes**

Run: `cd frontend && yarn vitest run src/pages/ReportsLayout.test.tsx`
Expected: PASS (3 tests).

- [ ] **Step 5: Nest the reports routes in `App.tsx`**

Add import near the other page imports:
```tsx
import { ReportsLayout } from './pages/ReportsLayout'
```
Replace the flat reports route (`App.tsx:113`) and the three `reports/*` routes (`App.tsx:116-121`) with one nested block:
```tsx
          <Route path="reports" element={<ReportsLayout />}>
            <Route index element={<ReportsPage />} />
            <Route path="explain-month" element={<ExplainMonthPage />} />
            <Route path="lifestyle-inflation" element={<LifestyleInflationPage />} />
            <Route path="savings-rate" element={<SavingsRatePage />} />
          </Route>
```
(Leave the `ReportsPage`, `ExplainMonthPage`, `LifestyleInflationPage`, `SavingsRatePage` imports as-is.)

- [ ] **Step 6: Write the reports-routing integration test (guards the App nesting shape)**

Create `frontend/src/pages/reports-routing.integration.test.tsx`. Mock `@/lib/api` so the real pages mount without network (mirror `ReturnWarrantyPage.test.tsx`):

```tsx
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { ReportsLayout } from './ReportsLayout'
import { ExplainMonthPage } from './ExplainMonthPage'
import { ReportsPage } from './ReportsPage'
import * as api from '@/lib/api'
import { ToastProvider } from '@/components/ui/toast'

void React

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return { ...actual, getJson: vi.fn(), postJson: vi.fn(), deleteReq: vi.fn() }
})

beforeEach(() => {
  vi.mocked(api.getJson).mockResolvedValue({} as never)
})

function renderAt(path: string) {
  return render(
    <ToastProvider>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/reports" element={<ReportsLayout />}>
            <Route index element={<ReportsPage />} />
            <Route path="explain-month" element={<ExplainMonthPage />} />
          </Route>
        </Routes>
      </MemoryRouter>
    </ToastProvider>,
  )
}

describe('reports routing (PR 0)', () => {
  it('/reports renders the Reports summary under the tab bar', async () => {
    renderAt('/reports')
    expect(screen.getByRole('tab', { name: 'Summary' })).toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Reports' })).toBeInTheDocument())
  })

  it('/reports/explain-month mounts the Explain month page under the same tab bar', () => {
    renderAt('/reports/explain-month')
    expect(screen.getByRole('tab', { name: 'Explain month' })).toHaveAttribute('aria-selected', 'true')
  })
})
```

> If `getJson` mock typing complains, cast the resolved value as needed (`as never` is used above). If `ReportsPage`/`ExplainMonthPage` make additional `getJson` calls with specific shapes, return `{ byCurrency: [], data: [], findings: [] }`-style empties; the assertions only depend on the headers/tabs rendering, not data.

- [ ] **Step 7: Run both reports tests; verify pass**

Run: `cd frontend && yarn vitest run src/pages/ReportsLayout.test.tsx src/pages/reports-routing.integration.test.tsx`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add frontend/src/pages/ReportsLayout.tsx frontend/src/pages/ReportsLayout.test.tsx frontend/src/pages/reports-routing.integration.test.tsx frontend/src/App.tsx
git commit --no-verify -m "feat(reports): route-based tab bar; un-hoist Explain/Lifestyle/Savings from rail"
```

---

## Task 4: Whole-suite verification

**Files:** none (verification only)

- [ ] **Step 1: Typecheck**

Run: `cd frontend && yarn tsc --noEmit`
Expected: no errors. (Catches the removed `AskCashflowPage` import and any stale references.)

- [ ] **Step 2: Full test suite**

Run: `cd frontend && yarn test`
Expected: all pass. Pay attention to any existing test that navigated to `/ask`, `/audit-log`, `/sync`, or the flat `/reports/*` and now hits a redirect/layout — update those tests to the new paths if they fail.

- [ ] **Step 3: Lint**

Run: `cd frontend && yarn lint`
Expected: clean (no unused-import error for `AskCashflowPage`).

- [ ] **Step 4: Build**

Run: `cd frontend && yarn build`
Expected: succeeds.

- [ ] **Step 5: Manual smoke (optional, via the run/verify skill)**

Start the app; confirm: rail no longer shows Ask Cashflow / Audit log / Backup & sync / the 3 report items; Amazon + Credit cards appear under Money; visiting `/ask` lands on Chat; `/audit-log` lands on Settings ▸ Audit log; `/sync` lands on Settings ▸ Backup & sync; `/reports` shows the tab bar and the three report tabs switch correctly.

---

## Self-review notes

- **Spec coverage:** PR 0 row of the spec table → Tasks 1–3 (chrome→Settings, mis-files, un-hoist reports, Ask→Chat). Section-skeleton + `?view=`-for-reports intentionally deferred (see Deviations).
- **No item orphaned:** every removed rail item has a new home (Chat / Settings tab / Reports tab) or a redirect — no URL becomes unreachable.
- **Type consistency:** new `SettingsTopTab` members `'audit-log' | 'backup'` are added to both the union and `TOP_TAB_PATHS`; tab `value`s in `ReportsLayout` match `TAB_PATHS` keys and `activeReportTab` returns.
- **Out of scope for PR 0 (later PRs):** Transactions/Planned/Scenarios/Accounts/Portfolio folds, Sankey/Partner/Currency→Reports `?view=` tabs, Review→Inbox, final section re-skeleton.
