import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { CategoryIconPicker } from './CategoryIconPicker'

describe('CategoryIconPicker', () => {
  it('renders a button per icon and fires onSelect with the name', async () => {
    const onSelect = vi.fn()
    render(<CategoryIconPicker value={null} onSelect={onSelect} />)
    const coffeeButton = screen.getByRole('button', { name: 'Coffee' })
    await userEvent.click(coffeeButton)
    expect(onSelect).toHaveBeenCalledWith('Coffee')
  })

  it('renders a "None" choice that emits null', async () => {
    const onSelect = vi.fn()
    render(<CategoryIconPicker value="Coffee" onSelect={onSelect} />)
    await userEvent.click(screen.getByRole('button', { name: /none/i }))
    expect(onSelect).toHaveBeenCalledWith(null)
  })

  it('marks the current value as aria-pressed', () => {
    render(<CategoryIconPicker value="Coffee" onSelect={() => {}} />)
    expect(
      screen.getByRole('button', { name: 'Coffee' })
    ).toHaveAttribute('aria-pressed', 'true')
  })

  it('marks None as aria-pressed when value is null', () => {
    render(<CategoryIconPicker value={null} onSelect={() => {}} />)
    expect(
      screen.getByRole('button', { name: /none/i })
    ).toHaveAttribute('aria-pressed', 'true')
  })
})
