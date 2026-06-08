import { Outlet, useNavigate } from 'react-router-dom'
import { PageHeader } from '@/components/ui/page-header'
import { Tabs, type TabItem } from '@/components/ui/tabs'
import { useAuth } from '../../lib/useAuth'
import { useActiveSettingsTopTab, type SettingsTopTab } from './useActiveSettingsTopTab'

type SettingsTab = TabItem & { superadminOnly?: boolean; ownerOnly?: boolean }

const WORKSPACE_TABS: SettingsTab[] = [
  { value: 'settings', label: 'Settings' },
  { value: 'members', label: 'Members' },
  { value: 'contacts', label: 'Contacts' },
  { value: 'categories', label: 'Categories' },
  { value: 'labels', label: 'Labels' },
  { value: 'budgets', label: 'Budgets' },
  { value: 'saved-filters', label: 'Saved filters' },
  { value: 'notifications', label: 'Notifications' },
  { value: 'enrichment', label: 'Enrichment' },
  { value: 'imports', label: 'Imports' },
]

const ADVANCED_TABS: SettingsTab[] = [
  { value: 'jobs', label: 'Jobs' },
  { value: 'audit-tokens', label: 'AI audit tokens' },
  { value: 'reporting-tokens', label: 'Reporting tokens' },
  { value: 'audit-log', label: 'Audit log' },
  { value: 'backup', label: 'Backup & sync' },
  { value: 'feedback', label: 'Feedback', ownerOnly: true },
  { value: 'whatsnew', label: "What's new" },
]


const TOP_TAB_PATHS: Record<SettingsTopTab, string> = {
  settings: '/settings/display',
  imports: '/settings/imports',
  enrichment: '/settings/enrichment',
  contacts: '/settings/contacts',
  members: '/settings/members',
  budgets: '/settings/budgets',
  categories: '/settings/categories',
  labels: '/settings/labels',
  'saved-filters': '/settings/saved-filters',
  notifications: '/settings/notifications',
  feedback: '/settings/feedback',
  jobs: '/settings/jobs',
  whatsnew: '/settings/whatsnew',
  'audit-tokens': '/settings/audit-tokens',
  'reporting-tokens': '/settings/reporting-tokens',
  'audit-log': '/settings/audit-log',
  backup: '/settings/backup',
}

export function SettingsPage() {
  const auth = useAuth()
  const navigate = useNavigate()
  const activeTop = useActiveSettingsTopTab()
  const isSuperadmin = auth.user?.globalRole === 'superadmin'
  // Household owner (or superadmin) sees owner-only tabs like the feedback
  // inbox (issue #295). The backend GET /api/feedback also enforces this.
  const isOwner = auth.user?.household?.role === 'owner' || isSuperadmin
  const filterTabs = (tabs: SettingsTab[]): TabItem[] =>
    tabs
      .filter((t) => (!t.superadminOnly || isSuperadmin) && (!t.ownerOnly || isOwner))
      .map(({ value, label }) => ({ value, label }))
  const workspaceTabs = filterTabs(WORKSPACE_TABS)
  const advancedTabs = filterTabs(ADVANCED_TABS)

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
        <div className="flex flex-col gap-2">
          <div>
            <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Workspace</span>
            <Tabs
              items={workspaceTabs}
              value={activeTop}
              onValueChange={(v) => navigate(TOP_TAB_PATHS[v as SettingsTopTab])}
            />
          </div>
          <div>
            <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Advanced</span>
            <Tabs
              items={advancedTabs}
              value={activeTop}
              onValueChange={(v) => navigate(TOP_TAB_PATHS[v as SettingsTopTab])}
            />
          </div>
        </div>
      </div>
      <Outlet />
    </div>
  )
}
