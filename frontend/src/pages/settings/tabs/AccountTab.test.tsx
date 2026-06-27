import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom'
import { AccountTab } from './AccountTab'
import { AuthContext } from '@/lib/authContext'
import type { AuthState } from '@/lib/authContext'
import type { AuthUser } from '@/types/api'

function authState(user: AuthUser | null): AuthState {
  return {
    user,
    bootstrapRequired: false,
    loading: false,
    login: vi.fn(),
    demoLogin: vi.fn(),
    register: vi.fn(),
    logout: vi.fn(),
    refresh: vi.fn(),
  }
}

function userWithRole(role: string | null): AuthUser {
  return {
    id: 1,
    email: 'owner@example.com',
    displayName: 'Owner',
    globalRole: 'user',
    household: role === null ? null : { id: 1, name: 'My Household', role },
  }
}

function renderTab(user: AuthUser | null) {
  render(
    <AuthContext.Provider value={authState(user)}>
      <AccountTab />
    </AuthContext.Provider>,
  )
}

describe('AccountTab', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('shows the delete affordance for the household owner', () => {
    renderTab(userWithRole('owner'))
    expect(screen.getByRole('button', { name: /delete account/i })).toBeInTheDocument()
  })

  it('opens the confirmation modal when the owner clicks delete', async () => {
    renderTab(userWithRole('owner'))
    await userEvent.click(screen.getByRole('button', { name: /delete account/i }))
    expect(screen.getByLabelText(/household name confirmation/i)).toBeInTheDocument()
  })

  it('does not show the delete affordance for a non-owner member', () => {
    renderTab(userWithRole('member'))
    expect(screen.queryByRole('button', { name: /delete account/i })).not.toBeInTheDocument()
    expect(screen.getByText(/only the household owner/i)).toBeInTheDocument()
  })
})
