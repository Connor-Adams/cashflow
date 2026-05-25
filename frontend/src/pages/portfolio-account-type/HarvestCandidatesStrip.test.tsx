import React from 'react'
import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { HarvestCandidatesStrip } from './HarvestCandidatesStrip'

describe('HarvestCandidatesStrip', () => {
  it('returns null when candidates empty', () => {
    const { container } = render(<HarvestCandidatesStrip candidates={[]} />)
    expect(container.firstChild).toBeNull()
  })

  it('renders loss amount per candidate', () => {
    const { container, getByText } = render(
      <HarvestCandidatesStrip
        candidates={[
          {
            securityId: 1, symbol: 'BND', accountId: 5, accountName: 'NR',
            unrealizedLossCad: 612.5,
            superficialLossWarning: false, superficialLossDetail: null,
          },
        ]}
      />,
    )
    expect(getByText(/BND/)).not.toBeNull()
    expect(container.textContent).toContain('$612.50')
  })

  it('renders superficial-loss detail when warning is true', () => {
    const { getByText } = render(
      <HarvestCandidatesStrip
        candidates={[
          {
            securityId: 1, symbol: 'BND', accountId: 5, accountName: 'NR',
            unrealizedLossCad: 612.5,
            superficialLossWarning: true,
            superficialLossDetail: 'Buy in RRSP01 on 2026-05-10 within ±30 days of today.',
          },
        ]}
      />,
    )
    expect(getByText(/Superficial loss risk/i)).not.toBeNull()
    expect(getByText(/RRSP01/)).not.toBeNull()
  })
})
