import React from 'react'
import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { BucketCard } from './BucketCard'

const bucket = {
  taxStatus: 'registered_tfsa' as const,
  label: 'TFSA',
  accounts: [{ id: 1, name: 'TFSA01', currency: 'CAD' }],
  holdingsCount: 3,
  totalCadMV: 42300,
  allocationByAssetType: [
    { assetType: 'ETF', marketValueCad: 30000, percentage: 70.9 },
    { assetType: 'BOND', marketValueCad: 12300, percentage: 29.1 },
  ],
  rows: [],
}

describe('BucketCard', () => {
  it('renders label + total + holdings count', () => {
    const { getByText } = render(<BucketCard bucket={bucket} />)
    expect(getByText('TFSA')).not.toBeNull()
    expect(getByText(/\$42,300/)).not.toBeNull()
    expect(getByText(/3 holdings/)).not.toBeNull()
  })

  it('renders donut when allocationByAssetType has slices', () => {
    const { container } = render(<BucketCard bucket={bucket} />)
    expect(container.querySelector('svg')).not.toBeNull()
  })

  it('renders dash for null totalCadMV', () => {
    const { getByText } = render(<BucketCard bucket={{ ...bucket, totalCadMV: null }} />)
    expect(getByText('—')).not.toBeNull()
  })
})
