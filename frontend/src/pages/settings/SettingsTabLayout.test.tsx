import React from 'react'
import { render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { describe, it, expect } from 'vitest'
import { SettingsTabLayout } from './SettingsTabLayout'

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/settings" element={<SettingsTabLayout />}>
          <Route path="display" element={<div>display-marker</div>} />
          <Route path="gmail" element={<div>gmail-marker</div>} />
          <Route path="partner-invite" element={<div>invite-marker</div>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  )
}

describe('SettingsTabLayout', () => {
  it('renders three sidebar nav links', () => {
    renderAt('/settings/display')
    expect(screen.getByRole('link', { name: 'Display' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Gmail' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Partner invite' })).toBeInTheDocument()
  })

  it('renders the active outlet content', () => {
    renderAt('/settings/gmail')
    expect(screen.getByText('gmail-marker')).toBeInTheDocument()
  })

  it('marks the active link via aria-current', () => {
    renderAt('/settings/display')
    expect(screen.getByRole('link', { name: 'Display' })).toHaveAttribute('aria-current', 'page')
    expect(screen.getByRole('link', { name: 'Gmail' })).not.toHaveAttribute('aria-current')
  })
})
