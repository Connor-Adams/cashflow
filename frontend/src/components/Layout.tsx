import { NavLink, Outlet } from 'react-router-dom'
import {
  BarChart3,
  BookOpenCheck,
  PackageSearch,
  CreditCard,
  ClipboardCheck,
  LineChart,
  LayoutDashboard,
  LogOut,
  ReceiptText,
  Settings,
  Shield,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { useLayoutWidth } from '../lib/layoutWidth'
import { useAuth } from '../lib/useAuth'

const navItems = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard, end: true },
  { to: '/accounts', label: 'Accounts', icon: CreditCard },
  { to: '/review', label: 'Review', icon: ClipboardCheck },
  { to: '/transactions', label: 'Transactions', icon: ReceiptText },
  { to: '/portfolio', label: 'Portfolio', icon: LineChart },
  { to: '/amazon', label: 'Amazon', icon: PackageSearch },
  { to: '/rules', label: 'Rules', icon: BookOpenCheck },
  { to: '/reports', label: 'Reports', icon: BarChart3 },
  { to: '/settings', label: 'Settings', icon: Settings },
]

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
          {navItems.map((item) => {
            const Icon = item.icon
            return (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                className={({ isActive }) => `navLink${isActive ? ' isActive' : ''}`}
              >
                <Icon aria-hidden="true" />
                <span>{item.label}</span>
              </NavLink>
            )
          })}
        </nav>
        <div className="userMenu">
          <span>{auth.user?.displayName}</span>
          {auth.user?.globalRole === 'superadmin' && (
            <Badge variant="outline" className="superadminBadge">
              <Shield aria-hidden="true" />
              God mode
            </Badge>
          )}
          <Button type="button" variant="secondary" size="sm" onClick={() => void auth.logout()}>
            <LogOut aria-hidden="true" />
            Log out
          </Button>
        </div>
      </header>
      <main className="main" data-layout-width={layoutWidth}>
        <Outlet />
      </main>
    </div>
  )
}
