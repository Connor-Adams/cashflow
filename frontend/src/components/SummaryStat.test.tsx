import React from 'react'
import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { SummaryStat } from './SummaryStat'

describe('SummaryStat', () => {
  it('renders label and value', () => {
    const { getByText } = render(<SummaryStat label="Annual leak" value="$120" />)
    expect(getByText('Annual leak')).not.toBeNull()
    expect(getByText('$120')).not.toBeNull()
  })

  it('applies the warning token utility for tone="warn"', () => {
    const { getByText } = render(<SummaryStat label="Annual leak" value="$120" tone="warn" />)
    const valueEl = getByText('$120')
    expect(valueEl.className).toContain('text-warning')
    // No legacy accent alias left behind.
    expect(valueEl.getAttribute('style') ?? '').not.toContain('accent-warm')
  })

  it('omits the warning utility when tone is unset', () => {
    const { getByText } = render(<SummaryStat label="Spend" value="$50" />)
    expect(getByText('$50').className).not.toContain('text-warning')
  })
})
