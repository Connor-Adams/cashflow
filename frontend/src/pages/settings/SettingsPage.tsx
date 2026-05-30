import { Outlet, useNavigate } from 'react-router-dom'
import { PageHeader } from '@/components/ui/page-header'
import { Tabs, type TabItem } from '@/components/ui/tabs'
import { useAuth } from '../../lib/useAuth'
import { useActiveSettingsTopTab, type SettingsTopTab } from './useActiveSettingsTopTab'

const ALL_TOP_TABS: Array<
  TabItem & { superadminOnly?: boolean; ownerOnly?: boolean }
> = [
  { value: 'settings', label: 'Settings' },
  { value: 'imports', label: 'Imports' },
  { value: 'enrichment', label: 'Enrichment' },
  { value: 'contacts', label: 'Contacts' },
  { value: 'members', label: 'Members' },
  { value: 'budgets', label: 'Budgets' },
  { value: 'categories', label: 'Categories' },
  { value: 'labels', label: 'Labels' },
  { value: 'notifications', label: 'Notifications' },
  { value: 'feedback', label: 'Feedback', ownerOnly: true },
  { value: 'jobs', label: 'Jobs' },
  { value: 'audit', label: 'Audit tokens', ownerOnly: true },
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
  notifications: '/settings/notifications',
  feedback: '/settings/feedback',
  jobs: '/settings/jobs',
  audit: '/settings/audit',
}

export function SettingsPage() {
  const auth = useAuth()
  const navigate = useNavigate()
  const activeTop = useActiveSettingsTopTab()
  const isSuperadmin = auth.user?.globalRole === 'superadmin'
  // Household owner (or superadmin) sees owner-only tabs like the feedback
  // inbox (issue #295). The backend GET /api/feedback also enforces this.
  const isOwner = auth.user?.household?.role === 'owner' || isSuperadmin
  const TOP_TABS: TabItem[] = ALL_TOP_TABS
    .filter((t) => (!t.superadminOnly || isSuperadmin) && (!t.ownerOnly || isOwner))
    .map(({ value, label }) => ({ value, label }))

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
