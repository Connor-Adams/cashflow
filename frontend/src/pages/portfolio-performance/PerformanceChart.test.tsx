import React from 'react'
import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { PerformanceChart } from './PerformanceChart'

describe('PerformanceChart', () => {
  it('renders empty state when no data', () => {
    const { getByText } = render(<PerformanceChart points={[]} />)
    expect(getByText(/No data yet/i)).toBeInTheDocument()
  })

  it('renders 2 lines when data provided', () => {
    const { container } = render(<PerformanceChart points={[
      { date: '2026-01-01', portfolioValueCad: 1000, benchmarkValueCad: 1000, isPartial: false },
      { date: '2026-01-02', portfolioValueCad: 1050, benchmarkValueCad: 1020, isPartial: false },
    ]} />)
    expect(container.querySelector('svg')).not.toBeNull()
    const paths = container.querySelectorAll('path.recharts-curve')
    expect(paths.length).toBe(2)
  })
})
