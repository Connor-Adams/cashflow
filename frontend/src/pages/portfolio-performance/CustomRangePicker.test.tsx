import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { CustomRangePicker } from './CustomRangePicker'

describe('CustomRangePicker', () => {
  it('apply fires onApply with both dates', () => {
    const onApply = vi.fn()
    render(<CustomRangePicker from="2026-01-01" to="2026-05-01" onApply={onApply} />)
    fireEvent.click(screen.getByRole('button', { name: /apply/i }))
    expect(onApply).toHaveBeenCalledWith({ from: '2026-01-01', to: '2026-05-01' })
  })

  it('disables apply when from > to', () => {
    render(<CustomRangePicker from="2026-05-01" to="2026-01-01" onApply={() => {}} />)
    expect(screen.getByRole('button', { name: /apply/i })).toBeDisabled()
  })
})
