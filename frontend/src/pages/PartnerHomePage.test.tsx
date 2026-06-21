import React from 'react'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { PartnerHomePage } from './PartnerHomePage'

const fairness = {
  byCurrency: [
    {
      currency: 'CAD',
      balance: -50,
      direction: 'i_owe_partner',
      currentMonthSharedSpend: 120,
      sharedTransactionCount: 3,
    },
  ],
  excludeNonPartnerInflows: true,
}

let accounts: Array<{ id: number; name: string; visibility: string }> = []

vi.mock('../lib/api', () => ({
  getJson: vi.fn((path: string) =>
    path.includes('/partner/fairness')
      ? Promise.resolve(fairness)
      : Promise.resolve(accounts),
  ),
}))

function renderPage() {
  return render(
    <MemoryRouter>
      <PartnerHomePage />
    </MemoryRouter>,
  )
}

describe('PartnerHomePage', () => {
  beforeEach(() => {
    accounts = [{ id: 1, name: 'Joint', visibility: 'shared' }]
  })

  it('shows the viewer-relative balance direction', async () => {
    renderPage()
    expect(await screen.findByText(/you owe partner/i)).toBeInTheDocument()
  })

  it('nudges to share an account when nothing is shared', async () => {
    accounts = [{ id: 1, name: 'Solo', visibility: 'private' }]
    renderPage()
    expect(await screen.findByText(/nothing shared yet/i)).toBeInTheDocument()
  })
})
