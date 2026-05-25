import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ItemsFilterStrip } from './ItemsFilterStrip'

void React

describe('ItemsFilterStrip', () => {
  it('renders 5 chips', () => {
    render(<ItemsFilterStrip filters={{}} onChange={() => {}} />)
    expect(screen.getByRole('button', { name: /^category$/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^business use$/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^date$/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^vendor$/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^price$/i })).toBeInTheDocument()
  })

  it('opens a chip popover and applies value', () => {
    const onChange = vi.fn()
    render(<ItemsFilterStrip filters={{}} onChange={onChange} />)
    fireEvent.click(screen.getByRole('button', { name: /^vendor$/i }))
    const input = screen.getByPlaceholderText(/vendor name/i)
    fireEvent.change(input, { target: { value: 'amazon' } })
    fireEvent.click(screen.getAllByRole('button', { name: /apply/i })[0])
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ vendor: 'amazon' }))
  })

  it('shows active chip with value', () => {
    render(<ItemsFilterStrip filters={{ vendor: 'amazon' }} onChange={() => {}} />)
    expect(screen.getByRole('button', { name: /vendor: amazon/i })).toBeInTheDocument()
  })
})
