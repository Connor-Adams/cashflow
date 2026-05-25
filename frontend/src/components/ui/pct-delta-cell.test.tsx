import React from 'react'
import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { PctDeltaCell } from './pct-delta-cell'

describe('PctDeltaCell', () => {
  it('renders em-dash for null', () => {
    const { container } = render(<PctDeltaCell value={null} />)
    expect(container.textContent).toBe('—')
  })

  it('positive value renders up arrow with positive accent', () => {
    const { container } = render(<PctDeltaCell value={1.234} />)
    expect(container.textContent).toContain('↑')
    expect(container.textContent).toContain('1.23%')
    const span = container.querySelector('span')
    expect(span?.style.color).toContain('accent-positive')
  })

  it('negative value renders down arrow with warn accent + absolute pct', () => {
    const { container } = render(<PctDeltaCell value={-2.5} />)
    expect(container.textContent).toContain('↓')
    expect(container.textContent).toContain('2.50%')
    expect(container.textContent).not.toContain('-')
    const span = container.querySelector('span')
    expect(span?.style.color).toContain('accent-warm')
  })

  it('zero value renders up arrow (>= 0 branch)', () => {
    const { container } = render(<PctDeltaCell value={0} />)
    expect(container.textContent).toContain('↑')
    expect(container.textContent).toContain('0.00%')
  })
})
