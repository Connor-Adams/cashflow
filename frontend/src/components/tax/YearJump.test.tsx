import React from 'react'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { YearJump } from './YearJump'

const YEARS = [2024, 2025, 2026]

function renderYearJump() {
  const onChange = vi.fn()
  render(<YearJump years={YEARS} value={2025} onChange={onChange} />)
  return { onChange, input: screen.getByRole('combobox') }
}

describe('YearJump', () => {
  beforeEach(() => {
    localStorage.setItem('tax.yearJumpHintSeen', '1')
    vi.useFakeTimers()
  })
  afterEach(() => vi.useRealTimers())

  it('opens the year list on focus', () => {
    const { input } = renderYearJump()
    fireEvent.focus(input)
    expect(screen.getByRole('listbox')).toBeInTheDocument()
  })

  it('closes the list a beat after blur, so a click on an option still lands', () => {
    // The delay is the whole point: blur fires before the option's mousedown,
    // so closing synchronously would unmount the option out from under the click.
    const { input } = renderYearJump()
    fireEvent.focus(input)
    fireEvent.blur(input)

    expect(screen.getByRole('listbox')).toBeInTheDocument()
    act(() => { vi.advanceTimersByTime(150) })
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('does not fire the blur-close timer after unmount', () => {
    // Regression guard for the unguarded-timer class: this timer used to be a
    // bare setTimeout with no cleanup, free to run against a torn-down tree.
    const onChange = vi.fn()
    const { unmount } = render(
      <YearJump years={YEARS} value={2025} onChange={onChange} />,
    )
    fireEvent.focus(screen.getByRole('combobox'))
    fireEvent.blur(screen.getByRole('combobox'))

    unmount()
    expect(vi.getTimerCount()).toBe(0)
  })
})
