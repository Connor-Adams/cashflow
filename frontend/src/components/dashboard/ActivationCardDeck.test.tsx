import React from 'react'
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { ActivationCardDeck } from './ActivationCardDeck'

vi.mock('@/lib/api', () => ({
  getJson: vi.fn(() =>
    Promise.resolve({
      hasAccounts: false,
      unreviewedCount: 0,
      hasBudget: false,
      hasGoal: false,
      hasOutboundInvite: false,
      dismissedCards: [],
    }),
  ),
  postJson: vi.fn(() => Promise.resolve({})),
}))

describe('ActivationCardDeck', () => {
  it('points the invite card at the partner-invite settings route', async () => {
    render(
      <MemoryRouter>
        <ActivationCardDeck />
      </MemoryRouter>,
    )
    const cta = await screen.findByRole('link', { name: /send invite/i })
    expect(cta).toHaveAttribute('href', '/settings/partner-invite')
  })
})
