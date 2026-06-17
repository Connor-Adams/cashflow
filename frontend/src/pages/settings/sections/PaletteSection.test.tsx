import React from 'react'
import { render, screen, cleanup } from '@testing-library/react'
import { afterEach, describe, it, expect } from 'vitest'
import { PaletteSection } from './PaletteSection'

afterEach(() => {
  cleanup()
})

describe('PaletteSection', () => {
  it('renders the palette section heading', () => {
    render(<PaletteSection />)
    expect(screen.getByRole('heading', { name: /^palette$/i })).toBeInTheDocument()
  })

  it('renders all five group headings', () => {
    render(<PaletteSection />)
    expect(screen.getByRole('heading', { name: /^greyscale$/i })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: /^oxblood$/i })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: /^green$/i })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: /^semantic$/i })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: /^gradient$/i })).toBeInTheDocument()
  })

  it('renders a value readout for every swatch (39 total)', () => {
    render(<PaletteSection />)
    // 11 zinc + 10 oxblood + 6 green + 11 semantic + 1 gradient = 39
    expect(screen.getAllByTestId('swatch-value')).toHaveLength(39)
  })
})
