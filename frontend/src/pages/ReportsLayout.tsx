import { RouteTabsLayout } from './RouteTabsLayout'

/**
 * Route-based tab bar for the Reports family. Each tab is a child route, so the
 * pages render unchanged via Outlet and the old top-level routes only need
 * redirects. Retrofitted onto the shared RouteTabsLayout in PR 4, which also
 * folds Partner / Currency / Cashflow (sankey) in from the primary rail.
 */
export function ReportsLayout() {
  return (
    <RouteTabsLayout
      tabs={[
        { value: 'summary', label: 'Summary', path: '/reports' },
        { value: 'explain-month', label: 'Explain month', path: '/reports/explain-month' },
        { value: 'lifestyle-inflation', label: 'Lifestyle inflation', path: '/reports/lifestyle-inflation' },
        { value: 'savings-rate', label: 'Savings rate', path: '/reports/savings-rate' },
        { value: 'partner', label: 'Partner', path: '/reports/partner' },
        { value: 'currency', label: 'Currency', path: '/reports/currency' },
        { value: 'cashflow', label: 'Cashflow', path: '/reports/cashflow' },
      ]}
    />
  )
}
