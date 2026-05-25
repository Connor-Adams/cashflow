import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { AccountTypePanel } from './AccountTypePanel'
import * as api from '../../lib/api'

const baseData = {
  buckets: [
    {
      taxStatus: 'registered_tfsa' as const,
      label: 'TFSA',
      accounts: [{ id: 1, name: 'TFSA01', currency: 'CAD' }],
      holdingsCount: 1,
      totalCadMV: 4500,
      allocationByAssetType: [
        { assetType: 'ETF', marketValueCad: 4500, percentage: 100 },
      ],
      rows: [
        {
          securityId: 100, symbol: 'VOO', name: 'Vanguard', assetType: 'ETF',
          accountId: 1, accountName: 'TFSA01', quantity: 10, currency: 'USD',
          marketValue: 4500, marketValueCad: 6075,
          costBasis: 4000, unrealizedGainCad: 2075, weightInBucketPct: 100,
          flags: ['us_payer_in_tfsa' as const],
        },
      ],
    },
  ],
  warnings: [
    { kind: 'us_payer_in_tfsa' as const, securityId: 100, symbol: 'VOO', accountName: 'TFSA01', text: 'US payer in TFSA' },
  ],
  harvestCandidates: [],
}

describe('AccountTypePanel', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('renders bucket cards + warnings strip on happy path', async () => {
    vi.spyOn(api, 'getJson').mockResolvedValue(baseData)
    const { findByText, findAllByText } = render(
      <MemoryRouter>
        <AccountTypePanel />
      </MemoryRouter>,
    )
    expect((await findAllByText('TFSA')).length).toBeGreaterThan(0)
    expect(await findByText(/US payer in TFSA/i)).not.toBeNull()
  })

  it('renders empty state when buckets is empty', async () => {
    vi.spyOn(api, 'getJson').mockResolvedValue({ buckets: [], warnings: [], harvestCandidates: [] })
    const { findByText } = render(
      <MemoryRouter>
        <AccountTypePanel />
      </MemoryRouter>,
    )
    expect(await findByText(/No investment accounts/i)).not.toBeNull()
  })

  it('renders error state when fetch rejects', async () => {
    vi.spyOn(api, 'getJson').mockRejectedValue(new Error('boom'))
    const { findByText } = render(
      <MemoryRouter>
        <AccountTypePanel />
      </MemoryRouter>,
    )
    expect(await findByText(/boom|Could not load/i)).not.toBeNull()
  })
})
