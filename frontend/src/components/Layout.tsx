import { NavLink, Outlet } from 'react-router-dom'

export function Layout() {
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
        </nav>
      </header>
      <main className="main">
        <Outlet />
      </main>
    </div>
  )
}
