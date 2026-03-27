import { NavLink, Outlet } from 'react-router-dom'

const linkStyle = ({ isActive }: { isActive: boolean }) =>
  ({
    padding: '0.5rem 0.75rem',
    borderRadius: 6,
    textDecoration: 'none',
    color: isActive ? 'var(--fg)' : 'var(--muted)',
    background: isActive ? 'var(--bg2)' : 'transparent',
    fontWeight: isActive ? 600 : 400,
  }) as const

export function Layout() {
  return (
    <div className="layout">
      <header className="header">
        <div className="brand">Cashflow</div>
        <nav className="nav">
          <NavLink to="/" end style={linkStyle}>
            Dashboard
          </NavLink>
          <NavLink to="/accounts" style={linkStyle}>
            Accounts
          </NavLink>
          <NavLink to="/transactions" style={linkStyle}>
            Transactions
          </NavLink>
          <NavLink to="/rules" style={linkStyle}>
            Rules
          </NavLink>
          <NavLink to="/reports" style={linkStyle}>
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
