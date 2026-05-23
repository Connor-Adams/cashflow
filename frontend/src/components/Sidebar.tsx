import { NavLink } from 'react-router-dom'
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
  Repeat,
  Settings,
  Shield,
  Sun,
  Moon,
  Upload,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { useAuth } from '../lib/useAuth'
import { useTheme } from '../hooks/useTheme'

type NavItem = {
  to: string
  label: string
  icon: typeof LayoutDashboard
  end?: boolean
}

const navItems: NavItem[] = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard, end: true },
  { to: '/accounts', label: 'Accounts', icon: CreditCard },
  { to: '/review', label: 'Review', icon: ClipboardCheck },
  { to: '/transactions', label: 'Transactions', icon: ReceiptText },
  { to: '/import', label: 'Import', icon: Upload },
  { to: '/portfolio', label: 'Portfolio', icon: LineChart },
  { to: '/amazon', label: 'Amazon', icon: PackageSearch },
  { to: '/recurring', label: 'Recurring', icon: Repeat },
  { to: '/rules', label: 'Rules', icon: BookOpenCheck },
  { to: '/reports', label: 'Reports', icon: BarChart3 },
  { to: '/settings', label: 'Settings', icon: Settings },
]

type SidebarProps = {
  /** Drawer open state (mobile only — CSS hides this on desktop, sidebar
   *  is always visible at ≥768px). */
  open: boolean
  /** Fires when the user dismisses the drawer (link click, backdrop tap,
   *  Escape key). No-op on desktop. */
  onClose: () => void
}

/**
 * Left-rail navigation. Holds brand, primary nav, theme toggle, user
 * identity, and logout. Top-bar landmark is reserved for page-specific
 * content; sidebar owns the chrome.
 *
 * On viewports ≤768px the sidebar becomes a fixed off-canvas drawer
 * driven by the `open` prop. Desktop ignores `open` — CSS keeps the
 * sidebar pinned in the grid.
 */
export function Sidebar({ open, onClose }: SidebarProps) {
  return (
    <aside
      className="sidebar"
      data-open={open}
      aria-label="Primary navigation"
    >
      <SidebarBrand />
      <SidebarNavList items={navItems} onItemClick={onClose} />
      <SidebarFooter />
    </aside>
  )
}

function SidebarBrand() {
  return (
    <div className="sidebar__brand">
      <div className="brandMark">CF</div>
      <div>
        <div className="brandEyebrow">Household ledger</div>
        <div className="brand">Cashflow</div>
      </div>
    </div>
  )
}

function SidebarNavList({
  items,
  onItemClick,
}: {
  items: NavItem[]
  onItemClick: () => void
}) {
  return (
    <nav className="sidebar__nav" aria-label="Main">
      {items.map((item) => (
        <SidebarNavLink key={item.to} item={item} onClick={onItemClick} />
      ))}
    </nav>
  )
}

function SidebarNavLink({
  item,
  onClick,
}: {
  item: NavItem
  onClick: () => void
}) {
  const Icon = item.icon
  return (
    <NavLink
      to={item.to}
      end={item.end}
      onClick={onClick}
      className={navLinkClass}
    >
      <Icon aria-hidden="true" />
      <span>{item.label}</span>
    </NavLink>
  )
}

function navLinkClass({ isActive }: { isActive: boolean }): string {
  return isActive ? 'sidebar__navLink isActive' : 'sidebar__navLink'
}

function SidebarFooter() {
  const auth = useAuth()
  return (
    <div className="sidebar__footer">
      <ThemeToggleButton />
      <SidebarUser
        displayName={auth.user?.displayName}
        isSuperadmin={auth.user?.globalRole === 'superadmin'}
      />
      <Button
        type="button"
        variant="secondary"
        size="sm"
        onClick={() => void auth.logout()}
        className="sidebar__logout"
      >
        <LogOut aria-hidden="true" />
        Log out
      </Button>
    </div>
  )
}

function ThemeToggleButton() {
  const { theme, toggleTheme } = useTheme()
  const isDark = theme === 'dark'
  const targetLabel = isDark ? 'light' : 'dark'
  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={toggleTheme}
      title={`Switch to ${targetLabel} mode`}
      aria-label={`Switch to ${targetLabel} theme`}
      aria-pressed={isDark}
      className="sidebar__themeToggle"
    >
      {isDark ? <Sun size={18} /> : <Moon size={18} />}
      <span>{isDark ? 'Light mode' : 'Dark mode'}</span>
    </Button>
  )
}

function SidebarUser({
  displayName,
  isSuperadmin,
}: {
  displayName: string | undefined
  isSuperadmin: boolean
}) {
  return (
    <div className="sidebar__user">
      <span className="sidebar__userName">{displayName ?? 'Signed in'}</span>
      {isSuperadmin && (
        <Badge variant="outline" className="superadminBadge">
          <Shield aria-hidden="true" />
          God mode
        </Badge>
      )}
    </div>
  )
}
