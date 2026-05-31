import { useCallback, useMemo, useState, useEffect } from 'react'
import { NavLink, useLocation } from 'react-router-dom'
import {
  BarChart3,
  BookOpenCheck,
  FileCheck2,
  Calculator,
  CalendarClock,
  CalendarDays,
  CheckSquare,
  ChevronDown,
  Coins,
  HandCoins,
  Landmark,
  Package,
  PackageCheck,
  PackageSearch,
  CreditCard,
  ClipboardCheck,
  Droplet,
  Filter,
  Globe,
  Inbox,
  Lightbulb,
  LineChart,
  LayoutDashboard,
  Lock,
  LogOut,
  MessageSquare,
  ReceiptText,
  Repeat,
  RefreshCw,
  RotateCcw,
  ArrowLeftRight,
  DollarSign,
  Settings,
  Shield,
  BadgeDollarSign,
  Sun,
  Moon,
  GitCompare,
  Target,
  TrendingUp,
  Undo2,
  Upload,
  Users,
  Waypoints,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { useAuth } from '../lib/useAuth'
import { useTheme } from '../hooks/useTheme'
import { useAiInboxCount } from '@/hooks/useAiInboxCount'
import { useInsightsCount } from '@/hooks/useInsightsCount'
import { useAiStatus } from '@/hooks/useAiStatus'
import { FRONTEND_VERSION, useBackendVersion } from '../lib/version'

type NavItem = {
  to: string
  label: string
  icon: typeof LayoutDashboard
  end?: boolean
}

type NavSection = {
  id: string
  label: string
  items: NavItem[]
}

const navSections: NavSection[] = [
  {
    id: 'today',
    label: 'Today',
    items: [
      { to: '/', label: 'Dashboard', icon: LayoutDashboard, end: true },
      { to: '/review', label: 'Review', icon: ClipboardCheck },
      { to: '/inbox', label: 'Inbox', icon: Inbox },
      { to: '/chat', label: 'Chat', icon: MessageSquare },
    ],
  },
  {
    id: 'money',
    label: 'Money',
    items: [
      { to: '/accounts', label: 'Accounts', icon: CreditCard },
      { to: '/income', label: 'Income', icon: DollarSign },
      { to: '/credit-cards', label: 'Credit cards', icon: CreditCard },
      { to: '/transactions', label: 'Transactions', icon: ReceiptText },
      { to: '/refunds', label: 'Refunds', icon: Undo2 },
      { to: '/reimbursements', label: 'Reimbursements', icon: HandCoins },
      { to: '/search', label: 'Smart search', icon: Filter },
      { to: '/transfers', label: 'Transfers', icon: ArrowLeftRight },
      { to: '/statements', label: 'Statements', icon: FileCheck2 },
      { to: '/items', label: 'Items', icon: Package },
      { to: '/purchases', label: 'Purchases', icon: PackageCheck },
      { to: '/import', label: 'Import', icon: Upload },
      { to: '/amazon', label: 'Amazon', icon: PackageSearch },
      { to: '/recurring', label: 'Recurring', icon: Repeat },
      { to: '/subscriptions', label: 'Subscriptions', icon: RefreshCw },
      { to: '/return-warranty', label: 'Returns & warranties', icon: RotateCcw },
      { to: '/large-purchases', label: 'Large purchases', icon: BadgeDollarSign },
      { to: '/money-leaks', label: 'Money leaks', icon: Droplet },
    ],
  },
  {
    id: 'planning',
    label: 'Planning',
    items: [
      { to: '/planned', label: 'Planned', icon: CalendarClock },
      { to: '/calendar', label: 'Calendar', icon: CalendarDays },
      { to: '/goals', label: 'Goals', icon: Target },
      { to: '/forecast', label: 'Forecast', icon: TrendingUp },
      { to: '/debt', label: 'Debt payoff', icon: Landmark },
      { to: '/opportunity-cost', label: 'Opportunity cost', icon: Calculator },
      { to: '/scenarios', label: 'Scenarios', icon: GitCompare },
    ],
  },
  {
    id: 'investments',
    label: 'Investments',
    items: [
      { to: '/portfolio', label: 'Portfolio', icon: LineChart },
      { to: '/net-worth', label: 'Net worth', icon: Coins },
    ],
  },
  {
    id: 'insights',
    label: 'Insights & rules',
    items: [
      { to: '/rules', label: 'Rules', icon: BookOpenCheck },
      { to: '/insights', label: 'Insights', icon: Lightbulb },
      { to: '/reports', label: 'Reports', icon: BarChart3 },
      { to: '/sankey', label: 'Cashflow', icon: Waypoints },
      { to: '/vault', label: 'Vault', icon: Lock },
      { to: '/currency', label: 'Currency', icon: Globe },
      { to: '/monthly-close', label: 'Monthly close', icon: CheckSquare },
      { to: '/tax', label: 'Tax', icon: Calculator },
      { to: '/partner', label: 'Partner', icon: Users },
    ],
  },
]

// Settings is always visible at the bottom with no section header.
const settingsItem: NavItem = { to: '/settings', label: 'Settings', icon: Settings }

const STORAGE_KEY = 'sidebar.collapsed'

function loadCollapsed(): Set<string> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return new Set()
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? new Set<string>(parsed) : new Set()
  } catch {
    return new Set()
  }
}

function saveCollapsed(collapsed: Set<string>) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...collapsed]))
  } catch {
    // ignore storage errors
  }
}

function useSidebarCollapsed() {
  const [collapsed, setCollapsed] = useState<Set<string>>(loadCollapsed)

  const toggle = useCallback((sectionId: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(sectionId)) {
        next.delete(sectionId)
      } else {
        next.add(sectionId)
      }
      saveCollapsed(next)
      return next
    })
  }, [])

  const expand = useCallback((sectionId: string) => {
    setCollapsed((prev) => {
      if (!prev.has(sectionId)) return prev
      const next = new Set(prev)
      next.delete(sectionId)
      saveCollapsed(next)
      return next
    })
  }, [])

  return { collapsed, toggle, expand }
}

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
  const { collapsed, toggle, expand } = useSidebarCollapsed()
  const location = useLocation()

  // Auto-expand the section containing the currently active route.
  useEffect(() => {
    for (const section of navSections) {
      const isActive = section.items.some((item) =>
        item.end ? location.pathname === item.to : location.pathname.startsWith(item.to)
      )
      if (isActive) {
        expand(section.id)
        break
      }
    }
  }, [location.pathname, expand])

  const filteredSections = useMemo<NavSection[]>(() => {
    if (aiStatus?.openai === true) return navSections
    return navSections.map((section) => ({
      ...section,
      items: section.items.filter((i) => i.to !== '/chat'),
    }))
  }, [aiStatus])

  return (
    <aside
      className="sidebar"
      data-open={open}
      aria-label="Primary navigation"
    >
      <SidebarBrand />
      <SidebarNavSections
        sections={filteredSections}
        collapsed={collapsed}
        onToggle={toggle}
        onItemClick={onClose}
      />
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

function SidebarNavSections({
  sections,
  collapsed,
  onToggle,
  onItemClick,
}: {
  sections: NavSection[]
  collapsed: Set<string>
  onToggle: (id: string) => void
  onItemClick: () => void
}) {
  const { count: aiInboxCount } = useAiInboxCount()
  const { count: insightsCount } = useInsightsCount()

  function badgeFor(to: string): number {
    if (to === '/inbox') return aiInboxCount
    if (to === '/insights') return insightsCount
    return 0
  }

  return (
    <nav className="sidebar__nav" aria-label="Main">
      {sections.map((section) => (
        <div key={section.id} className="sidebar__section">
          <button
            type="button"
            className="sidebar__sectionHeader"
            aria-expanded={!collapsed.has(section.id)}
            onClick={() => onToggle(section.id)}
          >
            <span>{section.label}</span>
            <ChevronDown
              aria-hidden="true"
              className={`sidebar__sectionChevron${collapsed.has(section.id) ? ' sidebar__sectionChevron--collapsed' : ''}`}
            />
          </button>
          {!collapsed.has(section.id) && (
            <div className="sidebar__sectionItems">
              {section.items.map((item) => (
                <SidebarNavLink
                  key={item.to}
                  item={item}
                  onClick={onItemClick}
                  badgeCount={badgeFor(item.to)}
                />
              ))}
            </div>
          )}
        </div>
      ))}
      <SidebarNavLink
        item={settingsItem}
        onClick={onItemClick}
        badgeCount={0}
      />
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
