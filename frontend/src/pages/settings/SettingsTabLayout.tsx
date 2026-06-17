import { NavLink, Outlet } from 'react-router-dom'

type SubNavItem = { to: string; label: string }

const SUB_NAV: SubNavItem[] = [
  { to: '/settings/display', label: 'Display' },
  { to: '/settings/palette', label: 'Palette' },
  { to: '/settings/design-system', label: 'Design System' },
  { to: '/settings/gmail', label: 'Gmail' },
  { to: '/settings/partner-invite', label: 'Partner invite' },
]

export function SettingsTabLayout() {
  return (
    <div className="settingsTabLayout">
      <nav className="settingsSubnav" aria-label="Settings sections">
        {SUB_NAV.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            className={({ isActive }) =>
              isActive ? 'settingsSubnav__link isActive' : 'settingsSubnav__link'
            }
          >
            {item.label}
          </NavLink>
        ))}
      </nav>
      <div className="settingsTabLayout__content">
        <Outlet />
      </div>
    </div>
  )
}
