# Sidebar fold — PR 1 (Transaction fold) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans or subagent-driven-development to implement task-by-task. Steps use checkbox (`- [ ]`).

**Goal:** Fold the 8 Transaction-family nav items into tabs on `/transactions`, cutting the rail by 8 ([spec](../specs/2026-05-31-sidebar-fold-design.md)).

**Architecture:** **Route-based tabs**, not `?view=`. `/transactions` becomes a thin `TransactionsLayout` (tab strip + `<Outlet/>`); each view is a child route rendering its existing page **unchanged**. `TransactionsPage` (2567 LOC) is the index `All` tab and is not modified. Old top-level routes redirect into the new sub-routes.

**Tech Stack:** React 18, react-router-dom v6, Vitest + RTL, shared `Tabs` at `frontend/src/components/ui/tabs.tsx`.

## Why route tabs, not `?view=` (deviation from spec, evidence-based)

Profiled all 9 pages. Two facts forced the mechanism:

1. **`TransactionsPage` wipes every query param** after consuming its deep-link params (`setSearchParams({}, { replace: true })`, lines 233–275). A `?view=` value would be erased on mount.
2. **The 8 fold targets are heavyweight standalone pages** (262–634 LOC; `ReturnWarrantyPage` + `LargePurchasesPage` have their own local-state tabs; `ItemsPage` already owns `?tab=`/`?item=`/8 filter params). Route-mounting via `<Outlet/>` needs **zero body extraction**; `?view=` would require extracting panels from all of them plus the 2567-line parent.

Same pattern as PR 0's Reports/Settings. `?view=` stays reserved for folds where a view is a preset filter of one page (none here).

## Route + tab table

| Tab | Route | Component (unchanged) | Old route → redirect |
|---|---|---|---|
| All | `/transactions` (index) | `TransactionsPage` | — |
| Refunds | `/transactions/refunds` | `RefundsReviewPage` | `/refunds` |
| Transfers | `/transactions/transfers` | `TransfersPage` | `/transfers` |
| Purchases | `/transactions/purchases` | `PurchasesPage` | `/purchases` |
| Large | `/transactions/large` | `LargePurchasesPage` | `/large-purchases` |
| Returns | `/transactions/returns` | `ReturnWarrantyPage` | `/return-warranty` |
| Items | `/transactions/items` | `ItemsPage` | `/items` |
| Search | `/transactions/search` | `SearchPage` | `/search` |
| Leaks | `/transactions/leaks` | `MoneyLeaksPage` | `/money-leaks` |

`ItemsPage`'s internal `?tab=`/`?item=`/filter params live happily at `/transactions/items` — no `view` param exists to collide with.

## File structure

| File | Change | Responsibility |
|---|---|---|
| `frontend/src/pages/TransactionsLayout.tsx` | **create** | Tab strip (9 tabs) + `<Outlet/>`; active tab from pathname |
| `frontend/src/App.tsx` | modify | Nest the 8 views + index under `/transactions`; add 8 redirects |
| `frontend/src/components/Sidebar.tsx` | modify | Remove the 8 folded items from the Money section |
| `frontend/src/pages/TransactionsLayout.test.tsx` | **create** | Tabs render + navigate + active-from-URL |
| `frontend/src/pages/transactions-routing.integration.test.tsx` | **create** | index = TransactionsPage; a sub-route mounts under the layout |
| `frontend/src/components/Sidebar.test.tsx` | modify | Assert the 8 items are gone from the rail |

---

## Task 1: TransactionsLayout

**Files:** Create `frontend/src/pages/TransactionsLayout.tsx` + `TransactionsLayout.test.tsx`.

- [ ] **Step 1: Failing test** — `TransactionsLayout.test.tsx`:

```tsx
import React from 'react'
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { TransactionsLayout } from './TransactionsLayout'

void React

const TABS = ['All', 'Refunds', 'Transfers', 'Purchases', 'Large', 'Returns', 'Items', 'Search', 'Leaks']

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/transactions" element={<TransactionsLayout />}>
          <Route index element={<div>all-body</div>} />
          <Route path="refunds" element={<div>refunds-body</div>} />
          <Route path="leaks" element={<div>leaks-body</div>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  )
}

describe('TransactionsLayout (PR 1)', () => {
  it('renders all nine tabs and the All index body', () => {
    renderAt('/transactions')
    for (const name of TABS) {
      expect(screen.getByRole('tab', { name })).toBeInTheDocument()
    }
    expect(screen.getByText('all-body')).toBeInTheDocument()
  })

  it('marks the active tab from the URL', () => {
    renderAt('/transactions/refunds')
    expect(screen.getByRole('tab', { name: 'Refunds' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByText('refunds-body')).toBeInTheDocument()
  })

  it('navigates on tab click', async () => {
    renderAt('/transactions')
    await userEvent.click(screen.getByRole('tab', { name: 'Leaks' }))
    expect(screen.getByText('leaks-body')).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run → fail** — `cd frontend && yarn vitest run src/pages/TransactionsLayout.test.tsx` → FAIL (module missing).

- [ ] **Step 3: Create `TransactionsLayout.tsx`:**

```tsx
import { Outlet, useLocation, useNavigate } from 'react-router-dom'
import { Tabs, type TabItem } from '@/components/ui/tabs'

const TRANSACTION_TABS: TabItem[] = [
  { value: 'all', label: 'All' },
  { value: 'refunds', label: 'Refunds' },
  { value: 'transfers', label: 'Transfers' },
  { value: 'purchases', label: 'Purchases' },
  { value: 'large', label: 'Large' },
  { value: 'returns', label: 'Returns' },
  { value: 'items', label: 'Items' },
  { value: 'search', label: 'Search' },
  { value: 'leaks', label: 'Leaks' },
]

const TAB_PATHS: Record<string, string> = {
  all: '/transactions',
  refunds: '/transactions/refunds',
  transfers: '/transactions/transfers',
  purchases: '/transactions/purchases',
  large: '/transactions/large',
  returns: '/transactions/returns',
  items: '/transactions/items',
  search: '/transactions/search',
  leaks: '/transactions/leaks',
}

function activeTransactionTab(pathname: string): string {
  const m = pathname.match(/^\/transactions\/([^/]+)/)
  const seg = m?.[1]
  return seg && seg in TAB_PATHS ? seg : 'all'
}

/**
 * Route-based tab bar for the Transactions family. Each tab is a child route,
 * so the existing pages (Refunds, Transfers, …) render unchanged via Outlet and
 * the old top-level routes only need redirects. Mirrors ReportsLayout /
 * SettingsPage. Part of the 46->16 sidebar fold (PR 1). The index tab renders
 * the full TransactionsPage ("All").
 */
export function TransactionsLayout() {
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const active = activeTransactionTab(pathname)
  return (
    <div className="transactionsLayout">
      <div className="settingsTopTabs">
        <Tabs
          items={TRANSACTION_TABS}
          value={active}
          onValueChange={(v) => navigate(TAB_PATHS[v])}
        />
      </div>
      <Outlet />
    </div>
  )
}
```

- [ ] **Step 4: Run → pass** — `yarn vitest run src/pages/TransactionsLayout.test.tsx` → PASS (3).

- [ ] **Step 5: Commit** — `feat(transactions): route-based tab layout for the Transactions family`

---

## Task 2: Nest routes + redirects in App.tsx

**Files:** modify `frontend/src/App.tsx`; create `transactions-routing.integration.test.tsx`.

- [ ] **Step 1: Failing integration test** — `frontend/src/pages/transactions-routing.integration.test.tsx`. Mock `@/lib/api` (mirror `reports-routing.integration.test.tsx`) so the real pages mount without network. Mount the real `TransactionsLayout` + `RefundsReviewPage` under the nested shape and assert the layout wraps a sub-route. Use the lightest real sub-page (`RefundsReviewPage`, no router deps):

```tsx
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { TransactionsLayout } from './TransactionsLayout'
import { RefundsReviewPage } from './RefundsReviewPage'
import * as api from '@/lib/api'
import { ToastProvider } from '@/components/ui/toast'

void React

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return { ...actual, getJson: vi.fn(), postJson: vi.fn(), deleteReq: vi.fn() }
})

beforeEach(() => {
  vi.mocked(api.getJson).mockResolvedValue({ data: [], suggestions: [] } as never)
})

function renderAt(path: string) {
  return render(
    <ToastProvider>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/transactions" element={<TransactionsLayout />}>
            <Route index element={<div>all-ledger</div>} />
            <Route path="refunds" element={<RefundsReviewPage />} />
          </Route>
        </Routes>
      </MemoryRouter>
    </ToastProvider>,
  )
}

describe('transactions routing (PR 1)', () => {
  it('/transactions renders the All tab + tab bar', () => {
    renderAt('/transactions')
    expect(screen.getByRole('tab', { name: 'All' })).toBeInTheDocument()
    expect(screen.getByText('all-ledger')).toBeInTheDocument()
  })

  it('/transactions/refunds mounts the Refunds page under the same tab bar', () => {
    renderAt('/transactions/refunds')
    expect(screen.getByRole('tab', { name: 'Refunds' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('heading', { name: /refunds review/i })).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run → fail** (`heading /refunds review/` not under a tab bar yet, or layout not wired). Actually this test exercises the new components directly so it should pass once Task 1 is done — its real job is to lock the nesting contract App.tsx must match. Run it; if green, proceed; the App.tsx change below makes the app match this contract.

- [ ] **Step 3: Edit `App.tsx` — import the layout** (after the `TransactionsPage` import, ~line 35):

```tsx
import { TransactionsLayout } from './pages/TransactionsLayout'
```

- [ ] **Step 4: Replace the flat `/transactions` route** (currently `<Route path="transactions" element={<TransactionsPage />} />`) with the nested block:

```tsx
          <Route path="transactions" element={<TransactionsLayout />}>
            <Route index element={<TransactionsPage />} />
            <Route path="refunds" element={<RefundsReviewPage />} />
            <Route path="transfers" element={<TransfersPage />} />
            <Route path="purchases" element={<PurchasesPage />} />
            <Route path="large" element={<LargePurchasesPage />} />
            <Route path="returns" element={<ReturnWarrantyPage />} />
            <Route path="items" element={<ItemsPage />} />
            <Route path="search" element={<SearchPage />} />
            <Route path="leaks" element={<MoneyLeaksPage />} />
          </Route>
```

- [ ] **Step 5: Replace the 8 old flat routes with redirects.** Find each existing route and swap its element for a redirect (delete the old `<Route path="refunds" …>`, `transfers`, `purchases`, `large-purchases`, `return-warranty`, `items`, `search`, `money-leaks`, and add):

```tsx
          <Route path="refunds" element={<Navigate to="/transactions/refunds" replace />} />
          <Route path="transfers" element={<Navigate to="/transactions/transfers" replace />} />
          <Route path="purchases" element={<Navigate to="/transactions/purchases" replace />} />
          <Route path="large-purchases" element={<Navigate to="/transactions/large" replace />} />
          <Route path="return-warranty" element={<Navigate to="/transactions/returns" replace />} />
          <Route path="items" element={<Navigate to="/transactions/items" replace />} />
          <Route path="search" element={<Navigate to="/transactions/search" replace />} />
          <Route path="money-leaks" element={<Navigate to="/transactions/leaks" replace />} />
```

(The page component imports — `RefundsReviewPage`, `TransfersPage`, etc. — stay; they're now rendered under `/transactions/*`.)

- [ ] **Step 6: Run** `yarn vitest run src/pages/transactions-routing.integration.test.tsx` → PASS.

- [ ] **Step 7: Commit** — `feat(transactions): nest 8 family views as tabs; redirect old routes`

---

## Task 3: Remove the 8 items from the Sidebar rail

**Files:** modify `frontend/src/components/Sidebar.tsx` + `Sidebar.test.tsx`.

- [ ] **Step 1: Extend the failing Sidebar test** — add a case to `Sidebar.test.tsx`:

```tsx
  it('drops the Transaction-family items folded into /transactions tabs (PR 1)', () => {
    renderSidebar()
    for (const name of ['Refunds', 'Transfers', 'Purchases', 'Large purchases', 'Returns & warranties', 'Items', 'Smart search', 'Money leaks']) {
      expect(screen.queryByRole('link', { name })).not.toBeInTheDocument()
    }
    expect(screen.getByRole('link', { name: 'Transactions' })).toBeInTheDocument()
  })
```

- [ ] **Step 2: Run → fail** — the 8 links still present.

- [ ] **Step 3: Edit `Sidebar.tsx` Money section** — remove these 8 item lines (keep Accounts, Credit cards, Transactions, Reimbursements, Statements, Import, Amazon, Recurring, Subscriptions):

```tsx
{ to: '/refunds', label: 'Refunds', icon: Undo2 },                         // DELETE
{ to: '/search', label: 'Smart search', icon: Filter },                    // DELETE
{ to: '/transfers', label: 'Transfers', icon: ArrowLeftRight },            // DELETE
{ to: '/items', label: 'Items', icon: Package },                           // DELETE
{ to: '/purchases', label: 'Purchases', icon: PackageCheck },              // DELETE
{ to: '/return-warranty', label: 'Returns & warranties', icon: RotateCcw },// DELETE
{ to: '/large-purchases', label: 'Large purchases', icon: BadgeDollarSign },// DELETE
{ to: '/money-leaks', label: 'Money leaks', icon: Droplet },               // DELETE
```

- [ ] **Step 4: Remove now-unused lucide icon imports** — after deletion, check which of `Undo2, Filter, ArrowLeftRight, Package, PackageCheck, RotateCcw, BadgeDollarSign, Droplet` are unused elsewhere in `Sidebar.tsx` and drop them from the import block. (Verify each with a search before removing; `lint` in Task 4 will catch any miss.)

- [ ] **Step 5: Run → pass** — `yarn vitest run src/components/Sidebar.test.tsx`.

- [ ] **Step 6: Commit** — `feat(sidebar): remove 8 Transaction-family items folded into /transactions tabs`

---

## Task 4: Verify

- [ ] `cd frontend && yarn test` → all pass. Update any test that navigated to a now-redirected route (`/refunds`, `/search`, etc.) to the new path.
- [ ] `yarn lint` → clean (no unused-import errors).
- [ ] `yarn build` → `tsc -b` + `vite build` succeed.
- [ ] Smoke: `/transactions` shows the 9-tab bar; each tab loads its page; old routes redirect; rail Money section lost the 8 items.

## Out of scope (later PRs)

- Expectation fold → Planned (Reimbursements/Recurring/Subscriptions/Calendar/Forecast) — PR 2.
- Account/Scenario/Portfolio folds — PR 3. Statements & Amazon relocation handled there / PR 4.
- Reports `?view=` (Partner/Currency/Sankey) — PR 4. Review→Inbox — PR 5.
- Final section re-skeleton.
