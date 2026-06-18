import React from 'react'
import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { LetterAvatar } from './letter-avatar'

describe('LetterAvatar', () => {
  it('renders the first character uppercased', () => {
    const { container } = render(<LetterAvatar text="xeqt" />)
    expect(container.textContent).toBe('X')
  })

  it('produces a stable color for the same input across renders', () => {
    const a = render(<LetterAvatar text="BNS" />).container.firstChild as HTMLElement
    const b = render(<LetterAvatar text="BNS" />).container.firstChild as HTMLElement
    expect(a.style.backgroundColor).toBe(b.style.backgroundColor)
  })

  it('respects size prop', () => {
    const { container } = render(<LetterAvatar text="X" size="lg" />)
    const el = container.firstChild as HTMLElement
    expect(el.style.width).toBe('48px')
    expect(el.style.height).toBe('48px')
  })

  it('falls back to ? for empty text', () => {
    const { container } = render(<LetterAvatar text="" />)
    expect(container.textContent).toBe('?')
  })

  it('uses a var(--avatar-N) background and a var(--avatar-on-*) text color', () => {
    const el = render(<LetterAvatar text="connor" />).container.firstChild as HTMLElement
    expect(el.style.backgroundColor).toMatch(/var\(--avatar-\d{1,2}\)/)
    expect(el.style.color).toMatch(/var\(--avatar-on-(light|dark)\)/)
  })
})
