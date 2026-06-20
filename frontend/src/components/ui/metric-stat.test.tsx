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

  it('renders a positive delta as a green (positive tone) badge', () => {
    const { container } = render(<MetricStat label="x" value="1" deltaPct={1.23} />)
    const badge = container.querySelector('[data-slot="stat-card-delta"]')!
    expect(badge).not.toBeNull()
    expect(badge.getAttribute('data-tone')).toBe('positive')
    expect(badge.textContent).toContain('+1.23%')
  })

  it('renders a negative delta as a red (negative tone) badge', () => {
    const { container } = render(<MetricStat label="x" value="1" deltaPct={-2.5} />)
    const badge = container.querySelector('[data-slot="stat-card-delta"]')!
    expect(badge).not.toBeNull()
    expect(badge.getAttribute('data-tone')).toBe('negative')
    expect(badge.textContent).toContain('-2.50%')
  })

  it('omits the delta badge for a null delta', () => {
    const { container } = render(<MetricStat label="x" value="—" />)
    expect(container.querySelector('[data-slot="stat-card-delta"]')).toBeNull()
  })

  it('shows loading skeleton', () => {
    const { container } = render(<MetricStat label="x" value="1" loading />)
    expect(container.querySelector('[data-loading="true"]')).not.toBeNull()
  })
})
