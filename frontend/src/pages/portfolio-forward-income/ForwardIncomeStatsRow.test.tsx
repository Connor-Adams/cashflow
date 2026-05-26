import React from 'react'
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ForwardIncomeStatsRow } from './ForwardIncomeStatsRow'

describe('ForwardIncomeStatsRow', () => {
  it('renders 4 stats', () => {
    render(
      <ForwardIncomeStatsRow
        projectedAnnualIncomeCad={1234.56}
        forwardYieldPct={3.45}
        forwardYieldOnCostPct={4.10}
        computedAt="2026-05-25T10:00:00Z"
      />,
    )
    expect(screen.getByText(/\$1,234\.56/)).toBeInTheDocument()
    expect(screen.getByText(/3\.45%/)).toBeInTheDocument()
    expect(screen.getByText(/4\.10%/)).toBeInTheDocument()
    expect(screen.getByText(/2026/)).toBeInTheDocument()
  })
})
