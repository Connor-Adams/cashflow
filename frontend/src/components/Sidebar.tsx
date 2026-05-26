import { useMemo } from 'react'
import { NavLink } from 'react-router-dom'
import {
  BarChart3,
  BookOpenCheck,
  Calculator,
  CalendarClock,
  Coins,
  Package,
  PackageSearch,
  CreditCard,
  ClipboardCheck,
  LineChart,
  LayoutDashboard,
  LogOut,
  MessageSquare,
  ReceiptText,
  Repeat,
  Settings,
  Shield,
  Sparkles,
  Stethoscope,
  Sun,
  Moon,
  Upload,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { useAuth } from '../lib/useAuth'
import { useTheme } from '../hooks/useTheme'
import { useAiInboxCount } from '@/hooks/useAiInboxCount'
import { useAiStatus } from '@/hooks/useAiStatus'
import { FRONTEND_VERSION, useBackendVersion } from '../lib/version'

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
  { to: '/items', label: 'Items', icon: Package },
  { to: '/import', label: 'Import', icon: Upload },
  { to: '/portfolio', label: 'Portfolio', icon: LineChart },
  { to: '/net-worth', label: 'Net worth', icon: Coins },
  { to: '/amazon', label: 'Amazon', icon: PackageSearch },
  { to: '/planned', label: 'Planned', icon: CalendarClock },
  { to: '/recurring', label: 'Recurring', icon: Repeat },
  { to: '/rules', label: 'Rules', icon: BookOpenCheck },
  { to: '/ai/inbox', label: 'AI Inbox', icon: Sparkles },
  { to: '/ai/reviews', label: 'AI Reviews', icon: Stethoscope },
  { to: '/chat', label: 'Chat', icon: MessageSquare },
  { to: '/reports', label: 'Reports', icon: BarChart3 },
  // TODO: swap Calculator for a dedicated tax icon when one is available in lucide-react
  { to: '/tax', label: 'Tax', icon: Calculator },
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
  const aiStatus = useAiStatus()
  // Hide chat nav until status loads (avoids a flash) and when OpenAI is
  // not configured (chat is useless without a provider). Status is fetched
  // once on mount; on error it resolves to `{ openai: false }` so we fail
  // closed and hide the nav entry rather than leading users to a broken page.
  const filteredItems = useMemo(() => {
    if (aiStatus?.openai === true) return navItems
    return navItems.filter((i) => i.to !== '/chat')
  }, [aiStatus])

  return (
    <aside
      className="sidebar"
      data-open={open}
      aria-label="Primary navigation"
    >
      <SidebarBrand />
      <SidebarNavList items={filteredItems} onItemClick={onClose} />
      <SidebarFooter />
    </aside>
  )
}

function SidebarBrand() {
  return (
    <div className="sidebar__brand">
      <img src="/favicon-192x192.png" alt="" className="brandMark" />
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
  const { count: aiInboxCount } = useAiInboxCount()
  return (
    <nav className="sidebar__nav" aria-label="Main">
      {items.map((item) => (
        <SidebarNavLink
          key={item.to}
          item={item}
          onClick={onItemClick}
          badgeCount={item.to === '/ai/inbox' ? aiInboxCount : 0}
        />
      ))}
    </nav>
  )
}

function SidebarNavLink({
  item,
  onClick,
  badgeCount,
}: {
  item: NavItem
  onClick: () => void
  badgeCount: number
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
      {badgeCount > 0 ? (
        <Badge variant="secondary" className="sidebar__navBadge">
          {badgeCount}
        </Badge>
      ) : null}
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
      <SidebarVersion />
    </div>
  )
}

function SidebarVersion() {
  const backend = useBackendVersion()
  const backendVersion =
    backend.status === 'ok' ? backend.version : backend.status === 'loading' ? '…' : '?'
  const drift = backend.status === 'ok' && backend.version !== FRONTEND_VERSION
  return (
    <div className="sidebar__version" data-drift={drift} aria-label="Build versions">
      <span className="sidebar__versionRow">
        <span className="sidebar__versionLabel">fe</span>
        <span className="sidebar__versionValue">{FRONTEND_VERSION}</span>
      </span>
      <span className="sidebar__versionRow">
        <span className="sidebar__versionLabel">be</span>
        <span className="sidebar__versionValue">{backendVersion}</span>
      </span>
      {drift && (
        <span className="sidebar__versionDrift" role="status">
          versions differ
        </span>
      )}
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
