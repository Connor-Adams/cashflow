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
