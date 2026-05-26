import React from 'react'
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ByAssetTypeBreakdown } from './ByAssetTypeBreakdown'

describe('ByAssetTypeBreakdown', () => {
  it('renders asset type rows', () => {
    render(
      <ByAssetTypeBreakdown
        buckets={[
          { assetType: 'etf', byCurrency: [{ currency: 'CAD', amount: 60 }], totalCad: 60 },
          { assetType: 'equity', byCurrency: [{ currency: 'USD', amount: 50 }], totalCad: 68.5 },
        ]}
      />,
    )
    expect(screen.getByText('etf')).toBeInTheDocument()
    expect(screen.getByText('equity')).toBeInTheDocument()
  })
})
