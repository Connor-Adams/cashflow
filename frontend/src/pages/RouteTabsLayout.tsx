import { Outlet, useLocation, useNavigate } from 'react-router-dom'
import { Tabs, type TabItem } from '@cashflow/ui'

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

// Groups the two inbox-y surfaces under /inbox WITHOUT merging their data
// (different machines: proposals on /api/review-items vs transaction review on
// /api/transactions). Nav-only fold — PR 5.
export const InboxLayout = () => (
  <RouteTabsLayout
    tabs={[
      { value: 'proposals', label: 'Proposals', path: '/inbox' },
      { value: 'review', label: 'Transaction review', path: '/inbox/review' },
    ]}
  />
)

// Expectation family (planned events + calendar/forecast views + recurring/
// subscriptions/reimbursements) grouped under /planned — PR 2. Unblocked once
// the backend Expectation merge landed (pages unchanged, endpoints preserved).
export const PlannedLayout = () => (
  <RouteTabsLayout
    tabs={[
      { value: 'upcoming', label: 'Upcoming', path: '/planned' },
      { value: 'calendar', label: 'Calendar', path: '/planned/calendar' },
      { value: 'forecast', label: 'Forecast', path: '/planned/forecast' },
      { value: 'recurring', label: 'Recurring', path: '/planned/recurring' },
      { value: 'subscriptions', label: 'Subscriptions', path: '/planned/subscriptions' },
      { value: 'reimbursements', label: 'Reimbursements', path: '/planned/reimbursements' },
    ]}
  />
)
