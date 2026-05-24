import React from 'react'
import { render, screen, cleanup } from '@testing-library/react'
import { afterEach, describe, it, expect, vi } from 'vitest'
import { DisplaySection } from './DisplaySection'

vi.mock('@/lib/layoutWidth', () => ({
  useLayoutWidth: () => ['standard', vi.fn()] as const,
  layoutWidthOptions: [
    { value: 'standard', label: 'Standard', description: 'Default width.' },
    { value: 'wide', label: 'Wide', description: 'Wider layout.' },
    { value: 'ultrawide', label: 'Ultrawide', description: 'Ultrawide layout.' },
  ],
}))

afterEach(() => {
  cleanup()
})

describe('DisplaySection', () => {
  it('renders the display width heading', () => {
    render(<DisplaySection />)
    expect(screen.getByRole('heading', { name: /display width/i })).toBeTruthy()
  })

  it('renders the display-width radiogroup', () => {
    render(<DisplaySection />)
    expect(screen.getByRole('radiogroup', { name: /display width/i })).toBeTruthy()
  })
})
