import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { PerformanceRangeToggle } from './PerformanceRangeToggle'

describe('PerformanceRangeToggle', () => {
  it('renders 6 buttons', () => {
    render(<PerformanceRangeToggle value="1Y" onChange={() => {}} />)
    ;['1M', '3M', 'YTD', '1Y', 'All', 'Custom'].forEach((k) => {
      expect(screen.getByRole('button', { name: k })).toBeInTheDocument()
    })
  })

  it('marks selected with aria-pressed=true', () => {
    render(<PerformanceRangeToggle value="3M" onChange={() => {}} />)
    expect(screen.getByRole('button', { name: '3M' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: '1Y' })).toHaveAttribute('aria-pressed', 'false')
  })

  it('fires onChange', () => {
    const onChange = vi.fn()
    render(<PerformanceRangeToggle value="1Y" onChange={onChange} />)
    fireEvent.click(screen.getByRole('button', { name: '1M' }))
    expect(onChange).toHaveBeenCalledWith('1M')
  })
})
