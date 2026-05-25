import React from 'react'
import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { MetricStat } from './metric-stat'

describe('MetricStat', () => {
  it('renders label and value', () => {
    const { getByText } = render(<MetricStat label="MV" value="$1,234" />)
    expect(getByText('MV')).not.toBeNull()
    expect(getByText('$1,234')).not.toBeNull()
  })

  it('renders positive delta with up arrow', () => {
    const { container } = render(<MetricStat label="x" value="1" deltaPct={1.23} />)
    expect(container.textContent).toContain('↑')
    expect(container.textContent).toContain('1.23%')
  })

  it('renders negative delta with down arrow', () => {
    const { container } = render(<MetricStat label="x" value="1" deltaPct={-2.5} />)
    expect(container.textContent).toContain('↓')
    expect(container.textContent).toContain('2.50%')
  })

  it('renders em-dash for null delta', () => {
    const { container } = render(<MetricStat label="x" value="—" />)
    expect(container.textContent).toContain('—')
  })

  it('shows loading skeleton', () => {
    const { container } = render(<MetricStat label="x" value="1" loading />)
    expect(container.querySelector('[data-loading="true"]')).not.toBeNull()
  })
})
