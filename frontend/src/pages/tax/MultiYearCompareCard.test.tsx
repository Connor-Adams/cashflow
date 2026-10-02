import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

void React

vi.mock('../../hooks/useTaxYears', () => ({
  useTaxYearCompare: () => ({
    loading: false,
    error: null,
    years: [
      { year: 2024, computedAt: '', totals: { totalPayable: '5000.00', refundOrOwing: '450.25' } },
      { year: 2025, computedAt: '', totals: { totalPayable: '3724.47', refundOrOwing: '-1234.5' } },
    ],
  }),
}))

import { MultiYearCompareCard } from './MultiYearCompareCard'

describe('MultiYearCompareCard refund / owing column', () => {
  it('reads refundOrOwing, not gross totalPayable', () => {
    render(<MultiYearCompareCard from={2024} to={2025} />)
    expect(screen.getByText('Owing $450.25')).toBeInTheDocument()
    expect(screen.getByText('Refund $1,234.50')).toBeInTheDocument()
    expect(screen.queryByText('Owing $3,724.47')).not.toBeInTheDocument()
  })
})
