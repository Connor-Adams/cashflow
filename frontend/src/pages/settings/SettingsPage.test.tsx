import React from 'react'
import { render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { describe, it, expect, vi } from 'vitest'
import { SettingsPage } from './SettingsPage'

vi.mock('../../lib/useAuth', () => ({
  useAuth: () => ({
    user: { household: { name: 'Test HH' }, email: 't@x.io', globalRole: null },
  }),
}))

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/settings" element={<SettingsPage />}>
          <Route path="display" element={<div>display-marker</div>} />
          <Route path="imports" element={<div>imports-marker</div>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  )
}

describe('SettingsPage shell', () => {
  it('renders the Settings page header', () => {
    renderAt('/settings/display')
    expect(screen.getByRole('heading', { name: /settings/i })).toBeInTheDocument()
  })

  it('renders the non-superadmin top tabs in expected order', () => {
    renderAt('/settings/display')
    const tabs = screen.getAllByRole('tab')
    expect(tabs.map((t) => t.textContent)).toEqual([
      'Settings',
      'Imports',
      'Enrichment',
      'Contacts',
      'Members',
      'Budgets',
      'Categories',
      'Notifications',
      'Jobs',
    ])
  })

  it('marks Settings tab active for /settings/display', () => {
    renderAt('/settings/display')
    const settingsTab = screen.getByRole('tab', { name: 'Settings' })
    expect(settingsTab).toHaveAttribute('aria-selected', 'true')
  })

  it('marks Imports tab active for /settings/imports', () => {
    renderAt('/settings/imports')
    expect(screen.getByRole('tab', { name: 'Imports' })).toHaveAttribute(
      'aria-selected',
      'true',
    )
  })

  it('renders child outlet content', () => {
    renderAt('/settings/imports')
    expect(screen.getByText('imports-marker')).toBeInTheDocument()
  })
})
