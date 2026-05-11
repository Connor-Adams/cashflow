import { NavLink, Outlet } from 'react-router-dom'
import { useLayoutWidth } from '../lib/layoutWidth'
import { useAuth } from '../lib/useAuth'

export function Layout() {
  const auth = useAuth()
  const [layoutWidth] = useLayoutWidth()
  return (
    <div className="layout">
      <header className="header">
        <div className="brandLockup">
          <div className="brandMark">CF</div>
          <div>
            <div className="brandEyebrow">Household ledger</div>
            <div className="brand">Cashflow</div>
          </div>
        </div>
        <nav className="nav" aria-label="Main">
          <NavLink
            to="/"
            end
            className={({ isActive }) => `navLink${isActive ? ' isActive' : ''}`}
          >
            Dashboard
          </NavLink>
          <NavLink
            to="/accounts"
            className={({ isActive }) => `navLink${isActive ? ' isActive' : ''}`}
          >
            Accounts
          </NavLink>
          <NavLink
            to="/transactions"
            className={({ isActive }) => `navLink${isActive ? ' isActive' : ''}`}
          >
            Transactions
          </NavLink>
          <NavLink
            to="/rules"
            className={({ isActive }) => `navLink${isActive ? ' isActive' : ''}`}
          >
            Rules
          </NavLink>
          <NavLink
            to="/reports"
            className={({ isActive }) => `navLink${isActive ? ' isActive' : ''}`}
          >
            Reports
          </NavLink>
          <NavLink
            to="/settings"
            className={({ isActive }) => `navLink${isActive ? ' isActive' : ''}`}
          >
            Settings
          </NavLink>
        </nav>
        <div className="userMenu">
          <span>{auth.user?.displayName}</span>
          {auth.user?.globalRole === 'superadmin' && (
            <span className="superadminBadge">God mode</span>
          )}
          <button type="button" onClick={() => void auth.logout()}>
            Log out
          </button>
        </div>
      </header>
      <main className="main" data-layout-width={layoutWidth}>
        <Outlet />
      </main>
    </div>
  )
}
