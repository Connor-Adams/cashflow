import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Card } from '../card'
import { Input } from '../input'
import { Alert } from '../alert'
import { Skeleton } from '../skeleton'
import { EmptyState, EmptyTableRow } from '../empty-state'

describe('leaf primitives render', () => {
  it('Card renders content', () => {
    render(<Card>hello</Card>)
    expect(screen.getByText('hello')).toBeInTheDocument()
  })
  it('Input has the rounded bordered field classes', () => {
    render(<Input placeholder="amount" />)
    expect(screen.getByPlaceholderText('amount').className).toContain('border-input')
  })
  it('Alert error variant uses role=alert', () => {
    render(<Alert variant="error">boom</Alert>)
    expect(screen.getByRole('alert')).toHaveTextContent('boom')
  })
  it('Skeleton applies the shimmer class', () => {
    const { container } = render(<Skeleton className="h-4 w-10" />)
    expect(container.firstChild).toHaveClass('skeleton-shimmer')
  })
  it('EmptyState shows its title', () => {
    render(<EmptyState title="Nothing here" />)
    expect(screen.getByText('Nothing here')).toBeInTheDocument()
  })
  it('EmptyTableRow cell uses utility classes, not the legacy emptyStateCell', () => {
    render(
      <table><tbody>
        <EmptyTableRow colSpan={3} title="None" />
      </tbody></table>,
    )
    const cell = screen.getByText('None').closest('td')!
    expect(cell.className).toContain('px-4')
    expect(cell.className).not.toContain('emptyStateCell')
  })
})
