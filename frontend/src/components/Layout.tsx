import { useCallback, useEffect, useState } from 'react'
import { Outlet, useLocation } from 'react-router-dom'
import { Menu } from 'lucide-react'
import { useLayoutWidth } from '../lib/layoutWidth'
import { Sidebar } from './Sidebar'

export function Layout() {
  const [layoutWidth] = useLayoutWidth()
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const closeSidebar = useCallback(() => setSidebarOpen(false), [])
  const openSidebar = useCallback(() => setSidebarOpen(true), [])
  const location = useLocation()

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

  return (
    <div className="layout" data-sidebar-open={sidebarOpen}>
      <Sidebar open={sidebarOpen} onClose={closeSidebar} />

      {/* Mobile backdrop. Hidden via CSS on desktop. */}
      <button
        type="button"
        aria-label="Close navigation"
        className="sidebarBackdrop"
        onClick={closeSidebar}
        tabIndex={sidebarOpen ? 0 : -1}
      />

      <div className="layoutMain">
        <header className="topBar" aria-label="Top bar">
          <button
            type="button"
            className="hamburger"
            onClick={openSidebar}
            aria-label="Open navigation"
            aria-expanded={sidebarOpen}
            aria-controls="primary-navigation"
          >
            <Menu size={20} aria-hidden="true" />
          </button>
          <span className="topBar__wordmark">Cashflow</span>
        </header>

        <main className="main" data-layout-width={layoutWidth}>
          <Outlet />
        </main>
      </div>
    </div>
  )
}
