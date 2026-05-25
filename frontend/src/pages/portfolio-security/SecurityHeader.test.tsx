import React from 'react'
import { describe, it, expect, beforeEach } from 'vitest'
import { render } from '@testing-library/react'
import { SecurityHeader } from './SecurityHeader'
import { _resetAppConfigForTest } from '../../lib/appConfig'

describe('SecurityHeader', () => {
  beforeEach(() => {
    _resetAppConfigForTest()
    window.__APP_CONFIG__ = { logoDevToken: null, quoteProviderConfigured: true }
  })

  it('renders symbol + name + badges', () => {
    const { getByText } = render(
      <SecurityHeader
        security={{ id: 1, symbol: 'XEQT.TO', name: 'iShares', assetType: 'ETF', currency: 'CAD' }}
        overview={{
          securityId: 1, sector: 'Diversified', industry: null, country: null, exchange: 'TSX',
          description: null, metadataFetchedAt: null,
          backfill: { status: 'fresh', lastFetchedAt: null, nextRetryAt: null, coverageDays: 1 },
        }}
      />,
    )
    expect(getByText('XEQT.TO')).not.toBeNull()
    expect(getByText(/iShares/)).not.toBeNull()
    expect(getByText('ETF')).not.toBeNull()
    expect(getByText('CAD')).not.toBeNull()
    expect(getByText('TSX')).not.toBeNull()
    expect(getByText('Diversified')).not.toBeNull()
  })

  it('renders without overview', () => {
    const { getByText } = render(
      <SecurityHeader
        security={{ id: 1, symbol: 'TST', name: null, assetType: null, currency: 'USD' }}
        overview={null}
      />,
    )
    expect(getByText('TST')).not.toBeNull()
  })
})
