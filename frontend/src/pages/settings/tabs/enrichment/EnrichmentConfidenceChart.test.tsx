import React from 'react'
import { render, screen } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import { EnrichmentConfidenceChart } from './EnrichmentConfidenceChart'

describe('EnrichmentConfidenceChart', () => {
  it('renders the heading and the total row pill', () => {
    render(
      <EnrichmentConfidenceChart byConfidence={{ high: 9148, medium: 3812, low: 1525, '(none)': 762 }} />,
    )
    expect(screen.getByText(/confidence distribution/i)).toBeInTheDocument()
    // 9148 + 3812 + 1525 + 762 = 15247
    expect(screen.getByText('15,247 rows')).toBeInTheDocument()
  })

  it('renders all four bands with formatted counts', () => {
    render(
      <EnrichmentConfidenceChart byConfidence={{ high: 9148, medium: 3812, low: 1525, '(none)': 762 }} />,
    )
    expect(screen.getByText(/High/)).toBeInTheDocument()
    expect(screen.getByText('9,148')).toBeInTheDocument()
    expect(screen.getByText(/Med/)).toBeInTheDocument()
    expect(screen.getByText('3,812')).toBeInTheDocument()
    expect(screen.getByText(/Low/)).toBeInTheDocument()
    expect(screen.getByText('1,525')).toBeInTheDocument()
    expect(screen.getByText(/None/)).toBeInTheDocument()
    expect(screen.getByText('762')).toBeInTheDocument()
  })

  it('treats a missing band as 0', () => {
    render(<EnrichmentConfidenceChart byConfidence={{ high: 100 }} />)
    expect(screen.getByText(/High/)).toBeInTheDocument()
    expect(screen.getByText('100')).toBeInTheDocument()
    expect(screen.getByText(/Med/)).toBeInTheDocument()
    // Three zeros: med, low, none
    expect(screen.getAllByText('0')).toHaveLength(3)
  })

  it('renders an empty-row pill when there are no rows', () => {
    render(<EnrichmentConfidenceChart byConfidence={{}} />)
    expect(screen.getByText('0 rows')).toBeInTheDocument()
  })
})
