import React from 'react'
import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { AllocationDonut, type DonutSlice } from './allocation-donut'

describe('AllocationDonut', () => {
  it('renders empty placeholder when slices is empty', () => {
    const { getByText } = render(<AllocationDonut title="By type" slices={[]} />)
    expect(getByText('No data.')).not.toBeNull()
  })

  it('renders pie chart when slices present', () => {
    const slices: DonutSlice[] = [
      { key: 'a', name: 'A (CAD)', value: 500, currency: 'CAD', percentage: 50 },
      { key: 'b', name: 'B (CAD)', value: 500, currency: 'CAD', percentage: 50 },
    ]
    const { container, getByText } = render(<AllocationDonut title="By type" slices={slices} />)
    expect(getByText('By type')).not.toBeNull()
    expect(container.querySelector('svg')).not.toBeNull()
  })
})
