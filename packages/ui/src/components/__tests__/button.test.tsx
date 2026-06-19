import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Button } from '../button'

describe('Button', () => {
  it('renders children and the primary variant class', () => {
    render(<Button>Save</Button>)
    const btn = screen.getByRole('button', { name: 'Save' })
    expect(btn).toBeInTheDocument()
    expect(btn.className).toContain('bg-button-primary')
  })
  it('renders as a slotted child when asChild is set', () => {
    render(<Button asChild><a href="/x">Link</a></Button>)
    expect(screen.getByRole('link', { name: 'Link' })).toHaveClass('bg-button-primary')
  })
})
