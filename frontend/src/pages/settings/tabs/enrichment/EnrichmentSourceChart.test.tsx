import React from 'react'
import { render, screen } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import { EnrichmentSourceChart } from './EnrichmentSourceChart'

describe('EnrichmentSourceChart', () => {
  it('renders the heading and per-source rows', () => {
    render(
      <EnrichmentSourceChart bySource={{ rules: 10368, ai: 3354, manual: 1220, '(none)': 305 }} />,
    )
    expect(screen.getByText(/by source/i)).toBeInTheDocument()
    expect(screen.getByText('rules')).toBeInTheDocument()
    expect(screen.getByText('ai')).toBeInTheDocument()
    expect(screen.getByText('manual')).toBeInTheDocument()
    expect(screen.getByText('none')).toBeInTheDocument()
  })

  it('sorts rows by count descending', () => {
    const { container } = render(
      <EnrichmentSourceChart bySource={{ rules: 10368, ai: 3354, manual: 1220, '(none)': 305 }} />,
    )
    const labels = Array.from(container.querySelectorAll('.enrichSourceBar__label')).map(
      (el) => el.textContent,
    )
    expect(labels).toEqual(['rules', 'ai', 'manual', 'none'])
  })

  it('renders percentages rounded to whole numbers', () => {
    render(<EnrichmentSourceChart bySource={{ rules: 68, ai: 22, manual: 8, '(none)': 2 }} />)
    expect(screen.getByText(/68 · 68%/)).toBeInTheDocument()
    expect(screen.getByText(/22 · 22%/)).toBeInTheDocument()
    expect(screen.getByText(/8 · 8%/)).toBeInTheDocument()
    expect(screen.getByText(/2 · 2%/)).toBeInTheDocument()
  })

  it('renders an empty-state message when bySource is empty', () => {
    render(<EnrichmentSourceChart bySource={{}} />)
    expect(screen.getByText(/no source data yet/i)).toBeInTheDocument()
  })
})
