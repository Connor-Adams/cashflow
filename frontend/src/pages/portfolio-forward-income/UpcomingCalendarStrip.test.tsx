import React from 'react'
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { UpcomingCalendarStrip } from './UpcomingCalendarStrip'

describe('UpcomingCalendarStrip', () => {
  it('renders empty state when no entries', () => {
    render(<MemoryRouter><UpcomingCalendarStrip entries={[]} /></MemoryRouter>)
    expect(screen.getByText(/no payments expected/i)).toBeInTheDocument()
  })

  it('renders chips and links to drill', () => {
    render(
      <MemoryRouter>
        <UpcomingCalendarStrip
          entries={[
            { date: '2026-06-15', securityId: 42, symbol: 'VCN', estimatedTotalNative: 24, estimatedTotalCad: 24, currency: 'CAD', kind: 'dividend' },
          ]}
        />
      </MemoryRouter>,
    )
    expect(screen.getByText('VCN')).toBeInTheDocument()
    const link = screen.getByRole('link', { name: /VCN/i })
    expect(link.getAttribute('href')).toBe('/portfolio/security/42')
  })

  it('preserves order from props', () => {
    render(
      <MemoryRouter>
        <UpcomingCalendarStrip
          entries={[
            { date: '2026-06-15', securityId: 1, symbol: 'A', estimatedTotalNative: 1, estimatedTotalCad: 1, currency: 'CAD', kind: 'dividend' },
            { date: '2026-07-20', securityId: 2, symbol: 'B', estimatedTotalNative: 2, estimatedTotalCad: 2, currency: 'CAD', kind: 'dividend' },
          ]}
        />
      </MemoryRouter>,
    )
    const syms = screen.getAllByTestId('fi-cal-symbol').map((el) => el.textContent)
    expect(syms).toEqual(['A', 'B'])
  })
})
