import React from 'react'
import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { BucketBreakdownTable } from './BucketBreakdownTable'

const buckets = [
  {
    taxStatus: 'registered_tfsa' as const,
    label: 'TFSA',
    accounts: [{ id: 1, name: 'TFSA01', currency: 'CAD' }],
    holdingsCount: 1,
    totalCadMV: 4500,
    allocationByAssetType: [],
    rows: [
      {
        securityId: 100, symbol: 'VOO', name: 'Vanguard S&P', assetType: 'ETF',
        accountId: 1, accountName: 'TFSA01', quantity: 10, currency: 'USD',
        marketValue: 4500, marketValueCad: 6075,
        costBasis: 4000, unrealizedGainCad: 1500, weightInBucketPct: 100,
        flags: ['us_payer_in_tfsa' as const],
      },
    ],
  },
]

describe('BucketBreakdownTable', () => {
  it('renders one row per holding with bucket label prefix', () => {
    const { getByText, container } = render(<BucketBreakdownTable buckets={buckets} />)
    expect(getByText('VOO')).not.toBeNull()
    expect(getByText('TFSA')).not.toBeNull()
    expect(container.textContent).toContain('us_payer_in_tfsa')
  })

  it('renders empty message when no buckets have rows', () => {
    const { getByText } = render(<BucketBreakdownTable buckets={[]} />)
    expect(getByText(/No holdings/i)).not.toBeNull()
  })
})
