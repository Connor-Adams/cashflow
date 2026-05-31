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
 * this layout only renders the tab strip + Outlet. Part of the 46->16 sidebar
 * fold (PR 0) — un-hoists Explain/Lifestyle/Savings from the primary rail.
 */
export function ReportsLayout() {
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const active = activeReportTab(pathname)
  return (
    <div className="reportsLayout">
      <div className="settingsTopTabs">
        <Tabs
          items={REPORT_TABS}
          value={active}
          onValueChange={(v) => navigate(TAB_PATHS[v])}
        />
      </div>
      <Outlet />
    </div>
  )
}
