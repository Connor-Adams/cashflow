import { NavLink } from 'react-router-dom'
import { Icon } from '@connor-adams/designsystem'
import { cn } from '@/lib/utils'
import { useAuth } from '../../lib/useAuth'

type SettingsNavItem = { to: string; label: string; ownerOnly?: boolean }
type SettingsNavGroup = { id: string; label: string; items: SettingsNavItem[] }

const GROUPS: SettingsNavGroup[] = [
  {
    id: 'configuration',
    label: 'Configuration',
    items: [
      { to: '/settings/display', label: 'Display' },
      { to: '/settings/appearance', label: 'Appearance' },
      { to: '/settings/notifications', label: 'Notifications' },
      { to: '/settings/gmail', label: 'Gmail' },
      { to: '/settings/partner-invite', label: 'Partner invite' },
      { to: '/settings/members', label: 'Members' },
    ],
  },
  {
    id: 'library',
    label: 'Library',
    items: [
      { to: '/settings/categories', label: 'Categories' },
      { to: '/settings/labels', label: 'Labels' },
      { to: '/settings/contacts', label: 'Contacts' },
      { to: '/settings/saved-filters', label: 'Saved filters' },
    ],
  },
  {
    id: 'advanced',
    label: 'Advanced',
    items: [
      { to: '/settings/imports', label: 'Imports' },
      { to: '/settings/jobs', label: 'Jobs' },
      { to: '/settings/api-tokens', label: 'API tokens' },
      { to: '/settings/audit-log', label: 'Audit log' },
      { to: '/settings/backup', label: 'Backup & export' },
      { to: '/settings/data', label: 'Data export' },
      { to: '/settings/feedback', label: 'Feedback', ownerOnly: true },
      { to: '/settings/whatsnew', label: "What's new" },
    ],
  },
]

const linkBase = 'flex items-center justify-between rounded-md px-3 py-1.5 text-sm transition-colors'

export function SettingsSidebar() {
  const auth = useAuth()
  const isOwner =
    auth.user?.household?.role === 'owner' || auth.user?.globalRole === 'superadmin'

  return (
    <nav className="flex w-48 shrink-0 flex-col gap-4" aria-label="Settings sections">
      {GROUPS.map((group) => (
        <div key={group.id} className="flex flex-col gap-0.5">
          <span className="px-3 pb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {group.label}
          </span>
          {group.items.map((item) => {
            if (item.ownerOnly && !isOwner) {
              return (
                <span
                  key={item.to}
                  aria-disabled="true"
                  title="Owner only"
                  className={cn(linkBase, 'cursor-not-allowed text-muted-foreground/60')}
                >
                  {item.label}
                  <Icon name="lock" aria-hidden="true" className="size-3.5" />
                </span>
              )
            }
            return (
              <NavLink
                key={item.to}
                to={item.to}
                className={({ isActive }) =>
                  cn(
                    linkBase,
                    isActive
                      ? 'bg-card font-medium text-foreground shadow-sm'
                      : 'text-muted-foreground hover:text-foreground',
                  )
                }
              >
                {item.label}
              </NavLink>
            )
          })}
        </div>
      ))}
    </nav>
  )
}
