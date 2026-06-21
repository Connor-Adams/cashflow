import React from 'react'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, it, expect, vi } from 'vitest'
import { SettingsSidebar } from './SettingsSidebar'

const mockUseAuth = vi.fn()
vi.mock('../../lib/useAuth', () => ({ useAuth: () => mockUseAuth() }))

function renderSidebar(path = '/settings/display') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <SettingsSidebar />
    </MemoryRouter>,
  )
}

describe('SettingsSidebar', () => {
  it('renders the three group headers', () => {
    mockUseAuth.mockReturnValue({ user: { household: { role: 'member' }, globalRole: null } })
    renderSidebar()
    expect(screen.getByText('Configuration')).toBeInTheDocument()
    expect(screen.getByText('Library')).toBeInTheDocument()
    expect(screen.getByText('Advanced')).toBeInTheDocument()
  })

  it('renders Appearance and API tokens links (merged destinations)', () => {
    mockUseAuth.mockReturnValue({ user: { household: { role: 'member' }, globalRole: null } })
    renderSidebar()
    expect(screen.getByRole('link', { name: 'Appearance' })).toHaveAttribute('href', '/settings/appearance')
    expect(screen.getByRole('link', { name: 'API tokens' })).toHaveAttribute('href', '/settings/api-tokens')
  })

  it('does NOT render Budgets or Enrichment (moved/removed)', () => {
    mockUseAuth.mockReturnValue({ user: { household: { role: 'owner' }, globalRole: null } })
    renderSidebar()
    expect(screen.queryByRole('link', { name: 'Budgets' })).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Enrichment' })).not.toBeInTheDocument()
  })

  it('renders the Notifications link (issue #796)', () => {
    mockUseAuth.mockReturnValue({ user: { household: { role: 'member' }, globalRole: null } })
    renderSidebar()
    expect(screen.getByRole('link', { name: 'Notifications' })).toHaveAttribute(
      'href',
      '/settings/notifications',
    )
  })

  it('renders Feedback as a real link for owners', () => {
    mockUseAuth.mockReturnValue({ user: { household: { role: 'owner' }, globalRole: null } })
    renderSidebar()
    expect(screen.getByRole('link', { name: 'Feedback' })).toBeInTheDocument()
  })

  it('renders Feedback locked (not a link) for non-owners', () => {
    mockUseAuth.mockReturnValue({ user: { household: { role: 'member' }, globalRole: null } })
    renderSidebar()
    expect(screen.queryByRole('link', { name: /Feedback/ })).not.toBeInTheDocument()
    const locked = screen.getByText('Feedback')
    expect(locked.closest('[aria-disabled="true"]')).not.toBeNull()
  })

  it('treats superadmin as owner for Feedback', () => {
    mockUseAuth.mockReturnValue({ user: { household: { role: 'member' }, globalRole: 'superadmin' } })
    renderSidebar()
    expect(screen.getByRole('link', { name: 'Feedback' })).toBeInTheDocument()
  })
})
