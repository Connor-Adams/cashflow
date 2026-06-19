import React from 'react'
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { OpportunityCostPage } from './OpportunityCostPage'

void React

afterEach(() => cleanup())

describe('OpportunityCostPage empty state (#799)', () => {
  it('shows the "See what a purchase could cost you" EmptyState before a scenario is entered', () => {
    render(<OpportunityCostPage />)
    expect(screen.getByText('See what a purchase could cost you')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /try an example/i })).toBeInTheDocument()
  })

  it('hides the empty state and prefills the calculator amount when "Try an example" is clicked', async () => {
    render(<OpportunityCostPage />)
    await userEvent.click(screen.getByRole('button', { name: /try an example/i }))
    expect(screen.queryByText('See what a purchase could cost you')).not.toBeInTheDocument()
    // The calculator remounts with the example amount prefilled.
    const amount = screen.getByLabelText(/^amount$/i) as HTMLInputElement
    expect(Number(amount.value)).toBeGreaterThan(0)
  })
})
