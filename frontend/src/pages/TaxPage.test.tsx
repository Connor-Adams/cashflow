import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TaxPage } from './TaxPage'
import * as taxYears from '../hooks/useTaxYears'

void React

vi.mock('../hooks/useTaxYears', async () => {
  const actual = await vi.importActual<typeof import('../hooks/useTaxYears')>(
    '../hooks/useTaxYears',
  )
  return { ...actual, useTaxYears: vi.fn() }
})

// Tax tab children each fetch on mount; stub them so the page renders in
// isolation when years are present.
vi.mock('./tax/OverviewTab', () => ({ OverviewTab: () => <div data-testid="overview-tab" /> }))

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => cleanup())

function renderPage() {
  return render(
    <MemoryRouter>
      <TaxPage />
    </MemoryRouter>,
  )
}

describe('TaxPage empty state (#799)', () => {
  it('shows the "No tax years yet" EmptyState with an Import CTA when there are zero years', () => {
    vi.mocked(taxYears.useTaxYears).mockReturnValue({ years: [], error: null })
    renderPage()
    expect(screen.getByText('No tax years yet')).toBeInTheDocument()
    const cta = screen.getByRole('link', { name: /import a statement/i })
    expect(cta).toHaveAttribute('href', '/import')
  })

  it('does not show the empty state (or the Loading stall) while years are still loading', () => {
    vi.mocked(taxYears.useTaxYears).mockReturnValue({ years: null, error: null })
    renderPage()
    expect(screen.queryByText('No tax years yet')).not.toBeInTheDocument()
  })

  it('renders the tabs (not the empty state) when at least one year exists', () => {
    vi.mocked(taxYears.useTaxYears).mockReturnValue({ years: [2025], error: null })
    renderPage()
    expect(screen.queryByText('No tax years yet')).not.toBeInTheDocument()
    expect(screen.getByRole('tab', { name: /overview/i })).toBeInTheDocument()
  })
})
