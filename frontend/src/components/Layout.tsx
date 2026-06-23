import { useCallback, useEffect, useState } from 'react'
import { Outlet, useLocation } from 'react-router-dom'
import { Button, Icon } from '@connor-adams/designsystem'
import { useLayoutWidth } from '../lib/layoutWidth'
import { useCommandPalette } from '../hooks/useCommandPalette'
import { CommandPalette } from './CommandPalette'
import { Sidebar } from './Sidebar'
import { NotificationBell } from './notifications/NotificationBell'
import { WhatsNewBell } from './changelog/WhatsNewBell'
import { FeedbackButton } from './feedback/FeedbackButton'
import { ImportProgressBadge } from './import/ImportProgressBadge'
import { useActiveImports } from './import/useActiveImports'
import { useToast } from './ui/toast'

export function Layout() {
  const [layoutWidth] = useLayoutWidth()
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const closeSidebar = useCallback(() => setSidebarOpen(false), [])
  const openSidebar = useCallback(() => setSidebarOpen(true), [])
  const location = useLocation()
  // Issue #237: global finance command palette (⌘K / Ctrl+K). Hook owns
  // the global keydown listener; the toolbar button opens it for mouse
  // users.
  const palette = useCommandPalette()

  // Completion toast: fires when a batch transitions from active → terminal.
  const { justFinished, clearFinished } = useActiveImports()
  const { showToast } = useToast()
  useEffect(() => {
    if (!justFinished) return
    showToast({
      title: 'Import finished',
      description: `${justFinished.succeeded} imported, ${justFinished.skipped} skipped, ${justFinished.failed} failed`,
      variant: justFinished.failed > 0 ? 'warning' : 'success',
    })
    clearFinished()
  }, [justFinished, clearFinished, showToast])

  // Auto-close on route change so the mobile drawer doesn't linger after
  // the user picks a destination. Desktop ignores `open` so this is a
  // no-op there.
  useEffect(() => {
    setSidebarOpen(false)
  }, [location.pathname])

  // Escape-to-close + body-scroll-lock while the mobile drawer is open.
  useEffect(() => {
    if (!sidebarOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeSidebar()
    }
    document.addEventListener('keydown', onKey)
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = prevOverflow
    }
  }, [sidebarOpen, closeSidebar])

  // Living-gradient backdrop is reserved for the dashboard (index route). It
  // fades in here and fades out on every other route, so switching tabs reads
  // as a soft transition rather than a hard cut.
  const onDashboard = location.pathname === '/'

  return (
    <div className="layout" data-sidebar-open={sidebarOpen}>
      <div className="livingBg" data-active={onDashboard} aria-hidden="true" />
      <Sidebar open={sidebarOpen} onClose={closeSidebar} />

      {/* Mobile backdrop. Hidden via CSS on desktop. */}
      <button
        type="button"
        data-slot="backdrop"
        aria-label="Close navigation"
        className="sidebarBackdrop"
        onClick={closeSidebar}
        tabIndex={sidebarOpen ? 0 : -1}
      />

      <div className="layoutMain">
        <header className="topBar" aria-label="Top bar">
          <Button
            type="button"
            variant="ghost"
            className="hamburger"
            onClick={openSidebar}
            aria-label="Open navigation"
            aria-expanded={sidebarOpen}
            aria-controls="primary-navigation"
          >
            <Icon name="menu" size={20} aria-hidden="true" />
          </Button>
          <span className="topBar__wordmark">Cashflow</span>
          <div className="topBar__right ml-auto flex items-center gap-2">
            <ImportProgressBadge />
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => palette.setOpen(true)}
              aria-label="Open command palette"
              title="Command palette (⌘K / Ctrl+K)"
              className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background/60 px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
              data-testid="top-bar-command-palette-trigger"
            >
              <Icon name="command" size={14} aria-hidden="true" />
              <span className="hidden sm:inline">Search commands</span>
              <kbd className="ml-1 hidden font-mono text-[10px] sm:inline">
                ⌘K
              </kbd>
            </Button>
            <WhatsNewBell />
            <NotificationBell />
            <FeedbackButton />
          </div>
        </header>

        <main className="main" data-layout-width={layoutWidth}>
          <Outlet />
        </main>
      </div>

      {/* Global ⌘K / Ctrl+K finance command palette. Lives in the Layout so
          every authenticated page shares one instance. */}
      <CommandPalette open={palette.open} onOpenChange={palette.setOpen} />
    </div>
  )
}
