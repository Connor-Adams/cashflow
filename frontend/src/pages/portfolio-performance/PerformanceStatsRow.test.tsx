import React from 'react'
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { PerformanceStatsRow } from './PerformanceStatsRow'

const baseStat = {
  twrPct: 5.5, mwrPct: 6.1, benchmarkTwrPct: 4.0, vsBenchmarkDeltaPct: 1.5,
  startDate: '2026-01-01', endDate: '2026-05-25',
  startValueCad: 1000, endValueCad: 1055, netCashFlowCad: 0,
}

describe('PerformanceStatsRow', () => {
  it('renders 5 preset cards', () => {
    render(<PerformanceStatsRow presetStats={{
      '1M': baseStat, '3M': baseStat, 'YTD': baseStat, '1Y': baseStat, 'All': baseStat,
    }} />)
    expect(screen.getByText('1M')).toBeInTheDocument()
    expect(screen.getByText('3M')).toBeInTheDocument()
    expect(screen.getByText('YTD')).toBeInTheDocument()
    expect(screen.getByText('1Y')).toBeInTheDocument()
    expect(screen.getByText('All')).toBeInTheDocument()
  })

  it('shows TWR with vs-benchmark delta', () => {
    render(<PerformanceStatsRow presetStats={{
      '1M': baseStat, '3M': baseStat, 'YTD': baseStat, '1Y': baseStat, 'All': baseStat,
    }} />)
    expect(screen.getAllByText(/5\.50%/).length).toBeGreaterThan(0)
    expect(screen.getAllByText(/\+1\.50/).length).toBeGreaterThan(0)
  })
})
