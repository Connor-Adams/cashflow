import React from 'react'
import { render, screen } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import { PaletteSection } from './PaletteSection'

describe('PaletteSection', () => {
  it('renders the palette swatch groups', () => {
    render(<PaletteSection />)
    expect(screen.getByRole('heading', { name: /palette/i })).toBeInTheDocument()
    expect(screen.getAllByText(/greyscale/i).length).toBeGreaterThan(0)
    expect(screen.getAllByText(/oxblood/i).length).toBeGreaterThan(0)
    expect(screen.getAllByText(/gradient/i).length).toBeGreaterThan(0)
  })

  it('renders a value readout for every swatch', () => {
    render(<PaletteSection />)
    expect(screen.getAllByTestId('swatch-value').length).toBeGreaterThan(0)
  })
})
