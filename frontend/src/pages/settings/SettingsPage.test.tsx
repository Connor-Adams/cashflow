import React from 'react'
import { render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { describe, it, expect, vi } from 'vitest'
import { SettingsPage } from './SettingsPage'

vi.mock('../../lib/useAuth', () => ({
  useAuth: () => ({
    user: { household: { name: 'Test HH', role: 'owner' }, email: 't@x.io', globalRole: null },
  }),
}))

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/settings" element={<SettingsPage />}>
          <Route path="display" element={<div>display-marker</div>} />
          <Route path="categories" element={<div>categories-marker</div>} />
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

  it('renders the sidebar with grouped sections', () => {
    renderAt('/settings/display')
    expect(screen.getByRole('navigation', { name: 'Settings sections' })).toBeInTheDocument()
    expect(screen.getByText('Configuration')).toBeInTheDocument()
    expect(screen.getByText('Library')).toBeInTheDocument()
    expect(screen.getByText('Advanced')).toBeInTheDocument()
  })

  it('renders child outlet content', () => {
    renderAt('/settings/categories')
    expect(screen.getByText('categories-marker')).toBeInTheDocument()
  })
})
