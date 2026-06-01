# Sidebar fold — PR 3 (Scenario / Account / Portfolio) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans. Steps use checkbox (`- [ ]`).

**Goal:** Fold 6 nav items into 3 parents via route-based tabs ([spec](../specs/2026-05-31-sidebar-fold-design.md)). Chosen over PR 2 (Expectation family) to avoid the active, unmerged backend Expectation-merge program — none of PR 3's targets are in that program's keep-list.

**Architecture:** Same route-tab mechanism as PR 0/PR 1, but DRY: one generic `RouteTabsLayout` (config-driven) instead of a third hand-written layout. `AccountsLayout` / `PortfolioLayout` / `ScenariosLayout` are thin config wrappers. Each parent's index tab is its existing page, unchanged. Old top-level routes redirect into the new sub-routes. PR 0's `ReportsLayout` and PR 1's `TransactionsLayout` are left as-is (retrofitting them to the generic is a later cleanup).

**Tech Stack:** React 18, react-router-dom v6, Vitest + RTL, shared `Tabs` at `frontend/src/components/ui/tabs.tsx`.

## Route + tab table

| Parent | Tab | Route | Component (unchanged) | Old route -> redirect |
|---|---|---|---|---|
| **Accounts** | Balances | `/accounts` (index) | `AccountsPage` | — |
| | Credit cards | `/accounts/credit-cards` | `CreditCardPlannerPage` | `/credit-cards` |
| | Debt | `/accounts/debt` | `DebtPage` | `/debt` |
| | Statements | `/accounts/statements` | `StatementsPage` | `/statements` |
| **Scenarios** | Scenarios | `/scenarios` (index) | `ScenariosPage` | — |
| | Tax | `/scenarios/tax` | `TaxPage` | `/tax` |
| | Opportunity cost | `/scenarios/opportunity-cost` | `OpportunityCostPage` | `/opportunity-cost` |
| **Portfolio** | Positions | `/portfolio` (index) | `PortfolioPage` | — |
| | Net worth | `/portfolio/net-worth` | `NetWorthPage` | `/net-worth` |
| | *(no tab)* | `/portfolio/security/:id` | `PortfolioSecurityPage` | — (kept, nested) |

`/portfolio/security/:id` becomes a nested child of the portfolio layout (drill-down; Positions tab shows active). All other paths unchanged endpoints.

## File structure

| File | Change | Responsibility |
|---|---|---|
| `frontend/src/pages/RouteTabsLayout.tsx` | **create** | Generic config-driven tab layout + the 3 named layout exports |
| `frontend/src/App.tsx` | modify | Nest accounts/scenarios/portfolio; 6 redirects |
| `frontend/src/components/Sidebar.tsx` | modify | Remove the 6 folded items |
| `frontend/src/pages/RouteTabsLayout.test.tsx` | **create** | Generic active/navigate logic + the 3 configs' tab sets |
| `frontend/src/pages/accounts-routing.integration.test.tsx` | **create** | index + a sub-route mount under the layout |
| `frontend/src/components/Sidebar.test.tsx` | modify | Assert the 6 items gone |

---

## Task 1: Generic RouteTabsLayout + 3 configs

**Files:** Create `RouteTabsLayout.tsx` + `RouteTabsLayout.test.tsx`.

- [ ] **Step 1: Failing test** — `RouteTabsLayout.test.tsx`:

```tsx
import React from 'react'
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { AccountsLayout, PortfolioLayout, ScenariosLayout } from './RouteTabsLayout'

void React

function mountAccounts(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/accounts" element={<AccountsLayout />}>
          <Route index element={<div>balances-body</div>} />
          <Route path="credit-cards" element={<div>cc-body</div>} />
          <Route path="debt" element={<div>debt-body</div>} />
          <Route path="statements" element={<div>stmt-body</div>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  )
}

describe('RouteTabsLayout via AccountsLayout', () => {
  it('renders the 4 account tabs and the index body', () => {
    mountAccounts('/accounts')
    for (const name of ['Balances', 'Credit cards', 'Debt', 'Statements']) {
      expect(screen.getByRole('tab', { name })).toBeInTheDocument()
    }
    expect(screen.getByText('balances-body')).toBeInTheDocument()
  })

  it('marks the active tab from a nested URL', () => {
    mountAccounts('/accounts/credit-cards')
    expect(screen.getByRole('tab', { name: 'Credit cards' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByText('cc-body')).toBeInTheDocument()
  })

  it('navigates on tab click', async () => {
    mountAccounts('/accounts')
    await userEvent.click(screen.getByRole('tab', { name: 'Debt' }))
    expect(screen.getByText('debt-body')).toBeInTheDocument()
  })
})

describe('Scenario + Portfolio configs', () => {
  it('ScenariosLayout exposes 3 tabs', () => {
    render(
      <MemoryRouter initialEntries={['/scenarios']}>
        <Routes>
          <Route path="/scenarios" element={<ScenariosLayout />}>
            <Route index element={<div>s</div>} />
          </Route>
        </Routes>
      </MemoryRouter>,
    )
    for (const name of ['Scenarios', 'Tax', 'Opportunity cost']) {
      expect(screen.getByRole('tab', { name })).toBeInTheDocument()
    }
  })

  it('PortfolioLayout exposes Positions + Net worth and keeps Positions active on a security drilldown', () => {
    render(
      <MemoryRouter initialEntries={['/portfolio/security/42']}>
        <Routes>
          <Route path="/portfolio" element={<PortfolioLayout />}>
            <Route index element={<div>p</div>} />
            <Route path="security/:id" element={<div>sec</div>} />
          </Route>
        </Routes>
      </MemoryRouter>,
    )
    expect(screen.getByRole('tab', { name: 'Positions' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByText('sec')).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run → fail** — `cd frontend && yarn vitest run src/pages/RouteTabsLayout.test.tsx` → module missing.

- [ ] **Step 3: Create `RouteTabsLayout.tsx`:**

```tsx
import { Outlet, useLocation, useNavigate } from 'react-router-dom'
import { Tabs, type TabItem } from '@/components/ui/tabs'

export type RouteTab = { value: string; label: string; path: string }

/**
 * Generic route-based tab bar. `tabs[0]` is the index/default. Active tab =
 * the tab whose `path` is the longest prefix of the current pathname (so a
 * nested child route highlights its tab, and unknown sub-paths fall back to
 * the index). Renders the tab strip + an Outlet; child routes render their
 * pages unchanged. Shared by the 46->16 sidebar fold layouts (PR 3+).
 */
export function RouteTabsLayout({ tabs }: { tabs: RouteTab[] }) {
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const active =
    [...tabs]
      .sort((a, b) => b.path.length - a.path.length)
      .find((t) => pathname === t.path || pathname.startsWith(`${t.path}/`))?.value ?? tabs[0].value
  const items: TabItem[] = tabs.map((t) => ({ value: t.value, label: t.label }))
  const pathFor = (v: string) => tabs.find((t) => t.value === v)?.path ?? tabs[0].path
  return (
    <div className="routeTabsLayout">
      <div className="settingsTopTabs">
        <Tabs items={items} value={active} onValueChange={(v) => navigate(pathFor(v))} />
      </div>
      <Outlet />
    </div>
  )
}

export const AccountsLayout = () => (
  <RouteTabsLayout
    tabs={[
      { value: 'balances', label: 'Balances', path: '/accounts' },
      { value: 'credit-cards', label: 'Credit cards', path: '/accounts/credit-cards' },
      { value: 'debt', label: 'Debt', path: '/accounts/debt' },
      { value: 'statements', label: 'Statements', path: '/accounts/statements' },
    ]}
  />
)

export const ScenariosLayout = () => (
  <RouteTabsLayout
    tabs={[
      { value: 'scenarios', label: 'Scenarios', path: '/scenarios' },
      { value: 'tax', label: 'Tax', path: '/scenarios/tax' },
      { value: 'opportunity-cost', label: 'Opportunity cost', path: '/scenarios/opportunity-cost' },
    ]}
  />
)

export const PortfolioLayout = () => (
  <RouteTabsLayout
    tabs={[
      { value: 'positions', label: 'Positions', path: '/portfolio' },
      { value: 'net-worth', label: 'Net worth', path: '/portfolio/net-worth' },
    ]}
  />
)
```

- [ ] **Step 4: Run → pass.**
- [ ] **Step 5: Commit** — `feat(nav): generic RouteTabsLayout + Accounts/Scenarios/Portfolio configs`

---

## Task 2: Nest routes + redirects in App.tsx

**Files:** modify `App.tsx`; create `accounts-routing.integration.test.tsx`.

- [ ] **Step 1: Failing-ish integration test** (mirrors `transactions-routing.integration.test.tsx`): mount real `AccountsLayout` + `AccountsPage` index + `StatementsPage` child via `MemoryRouter`, mock `@/lib/api`, assert the tab bar wraps the index and a sub-route. (Locks the nesting contract.)

```tsx
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { AccountsLayout } from './RouteTabsLayout'
import { AccountsPage } from './AccountsPage'
import * as api from '@/lib/api'
import { ToastProvider } from '@/components/ui/toast'

void React
vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return { ...actual, getJson: vi.fn(), postJson: vi.fn(), patchJson: vi.fn(), deleteReq: vi.fn() }
})
beforeEach(() => { vi.mocked(api.getJson).mockResolvedValue([] as never) })

function renderAt(path: string) {
  return render(
    <ToastProvider>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/accounts" element={<AccountsLayout />}>
            <Route index element={<AccountsPage />} />
            <Route path="credit-cards" element={<div>cc-marker</div>} />
          </Route>
        </Routes>
      </MemoryRouter>
    </ToastProvider>,
  )
}

describe('accounts routing (PR 3)', () => {
  it('/accounts renders Balances tab + the Accounts page', async () => {
    renderAt('/accounts')
    expect(screen.getByRole('tab', { name: 'Balances' })).toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('heading', { name: /accounts/i })).toBeInTheDocument())
  })
  it('/accounts/credit-cards activates the Credit cards tab', () => {
    renderAt('/accounts/credit-cards')
    expect(screen.getByRole('tab', { name: 'Credit cards' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByText('cc-marker')).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Edit `App.tsx` imports** — add after the existing page imports:

```tsx
import { AccountsLayout, ScenariosLayout, PortfolioLayout } from './pages/RouteTabsLayout'
```

- [ ] **Step 3: Nest the 3 parents.** Replace `<Route path="accounts" element={<AccountsPage />} />` with:

```tsx
          <Route path="accounts" element={<AccountsLayout />}>
            <Route index element={<AccountsPage />} />
            <Route path="credit-cards" element={<CreditCardPlannerPage />} />
            <Route path="debt" element={<DebtPage />} />
            <Route path="statements" element={<StatementsPage />} />
          </Route>
```

Replace `<Route path="scenarios" element={<ScenariosPage />} />` with:

```tsx
          <Route path="scenarios" element={<ScenariosLayout />}>
            <Route index element={<ScenariosPage />} />
            <Route path="tax" element={<TaxPage />} />
            <Route path="opportunity-cost" element={<OpportunityCostPage />} />
          </Route>
```

Replace the two portfolio routes (`<Route path="portfolio" element={<PortfolioPage />} />` and `<Route path="portfolio/security/:id" element={<PortfolioSecurityPage />} />`) with:

```tsx
          <Route path="portfolio" element={<PortfolioLayout />}>
            <Route index element={<PortfolioPage />} />
            <Route path="net-worth" element={<NetWorthPage />} />
            <Route path="security/:id" element={<PortfolioSecurityPage />} />
          </Route>
```

- [ ] **Step 4: Convert the 6 old top-level routes to redirects** (use multi-line anchors with neighbour context to stay unique — nested children share the same `path="..."` segment at deeper indent). Each becomes:

```tsx
          <Route path="credit-cards" element={<Navigate to="/accounts/credit-cards" replace />} />
          <Route path="debt" element={<Navigate to="/accounts/debt" replace />} />
          <Route path="statements" element={<Navigate to="/accounts/statements" replace />} />
          <Route path="tax" element={<Navigate to="/scenarios/tax" replace />} />
          <Route path="opportunity-cost" element={<Navigate to="/scenarios/opportunity-cost" replace />} />
          <Route path="net-worth" element={<Navigate to="/portfolio/net-worth" replace />} />
```

- [ ] **Step 5: Run** the accounts integration test → pass.
- [ ] **Step 6: Commit** — `feat(nav): nest Accounts/Scenarios/Portfolio views as tabs; redirect old routes`

---

## Task 3: Remove the 6 items from the Sidebar

**Files:** modify `Sidebar.tsx` + `Sidebar.test.tsx`.

- [ ] **Step 1: Extend the Sidebar test:**

```tsx
  it('drops the items folded into Accounts/Scenarios/Portfolio tabs (PR 3)', () => {
    renderSidebar()
    for (const name of ['Credit cards', 'Statements', 'Debt payoff', 'Opportunity cost', 'Net worth', 'Tax']) {
      expect(screen.queryByRole('link', { name })).not.toBeInTheDocument()
    }
    for (const name of ['Accounts', 'Scenarios', 'Portfolio']) {
      expect(screen.getByRole('link', { name })).toBeInTheDocument()
    }
  })
```

- [ ] **Step 2: Run → fail.**
- [ ] **Step 3: Remove the 6 nav item lines** from `Sidebar.tsx` (Credit cards + Statements from Money; Debt payoff + Opportunity cost from Planning; Net worth from Investments; Tax from Insights).
- [ ] **Step 4: Remove now-unused lucide icons** — check `Landmark` (Debt), `Coins` (Net worth), and any other icon used only by a removed item; keep `Calculator` (used by Tax *and* Opportunity cost — verify it's unused only if both go, else keep), `CreditCard` (still used by Accounts), `FileCheck2` (Statements — check Import/others), `GitCompare` (Scenarios, kept). Let `lint` (Task 4) confirm.
- [ ] **Step 5: Run → pass.**
- [ ] **Step 6: Commit** — `feat(sidebar): remove 6 items folded into Accounts/Scenarios/Portfolio tabs`

---

## Task 4: Verify

- [ ] `cd frontend && yarn test` → all pass; update any test that navigated to a now-redirected route.
- [ ] `yarn lint` → clean.
- [ ] `yarn build` → succeeds.
- [ ] Smoke: `/accounts`, `/scenarios`, `/portfolio` show tab bars; each tab loads; 6 old routes redirect; `/portfolio/security/:id` still works.

## Out of scope

- Expectation family (PR 2 — held pending the backend Expectation merge).
- Reports `?view=` (Partner/Currency/Sankey), Review→Inbox, final section re-skeleton.
- Retrofitting `ReportsLayout`/`TransactionsLayout` onto the generic.
