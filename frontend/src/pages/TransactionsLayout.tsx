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
