/**
 * The tax reserve is one CAD figure: a single CAD reserve percent, one CAD row
 * per period, and FX substitutions surfaced rather than hidden.
 */
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import type {
  ReserveSettingsResponse,
  ReserveSummaryResponse,
} from '../../hooks/useTaxReserve'

const getJson = vi.fn()
vi.mock('@/lib/api', () => ({
  getJson: (...a: unknown[]) => getJson(...a),
  deleteReq: vi.fn(),
}))

import { TaxReserveTab } from './TaxReserveTab'

function settings(over: Partial<ReserveSettingsResponse> = {}): ReserveSettingsResponse {
  return {
    data: [{ currency: 'CAD', reservePercent: '0.2500', note: null, isDefault: true }],
    currency: 'CAD',
    ignored: [],
    ...over,
  }
}

function summary(over: Partial<ReserveSummaryResponse> = {}): ReserveSummaryResponse {
  return {
    data: [
      {
        currency: 'CAD',
        period: '2026-Q1',
        sourceCurrencies: ['CAD', 'USD'],
        components: { businessIncome: 14000, deductibleExpenses: 2000, hstGstCollected: 0, hstGstPaid: 0 },
        netBusinessIncome: 12000,
        netHstGst: 0,
        reservePercent: 0.25,
        reserveTarget: 3000,
      },
    ],
    currency: 'CAD',
    reservePercent: 0.25,
    warnings: [],
    scope: 'business',
    periodicity: 'quarterly',
    disclaimer: 'Planning support only. Not tax filing advice. Confirm with your accountant.',
    ...over,
  }
}

function serve(s: ReserveSettingsResponse, m: ReserveSummaryResponse) {
  getJson.mockImplementation(async (path: string) =>
    path.startsWith('/api/tax/reserve/settings') ? s : m,
  )
}

describe('TaxReserveTab', () => {
  beforeEach(() => {
    getJson.mockReset()
  })

  it('edits a single CAD reserve percent, not one per currency', async () => {
    serve(settings(), summary())
    render(<TaxReserveTab year={2026} />)
    const input = await screen.findByLabelText(/reserve percent/i)
    expect(input).toHaveValue(25)
    expect(screen.getAllByLabelText(/reserve percent/i)).toHaveLength(1)
  })

  it('shows one CAD row per period and says which currencies were converted', async () => {
    serve(settings(), summary())
    render(<TaxReserveTab year={2026} />)
    const table = await screen.findByRole('table', { name: /reserve targets/i })
    expect(within(table).queryByRole('columnheader', { name: /^currency$/i })).toBeNull()
    expect(within(table).getByText('2026-Q1')).toBeInTheDocument()
    expect(within(table).getByText(/incl\. USD/)).toBeInTheDocument()
    expect(screen.getByText(/all amounts in CAD/i)).toBeInTheDocument()
  })

  it('surfaces FX fallback warnings', async () => {
    const warning =
      'No USD→CAD exchange rate on or before 2020-01-02; those amounts were converted at the 2021-05-26 rate, which is dated AFTER the transaction. Add the historical rate and recompute.'
    serve(settings(), summary({ warnings: [warning] }))
    render(<TaxReserveTab year={2026} />)
    expect(await screen.findByText(warning)).toBeInTheDocument()
  })

  it('names legacy per-currency rates that no longer apply', async () => {
    serve(
      settings({ ignored: [{ currency: 'USD', reservePercent: '0.3000', note: null, isDefault: false }] }),
      summary(),
    )
    render(<TaxReserveTab year={2026} />)
    expect(await screen.findByText(/USD 30(\.00)?%/)).toBeInTheDocument()
    expect(screen.getByText(/no longer used/i)).toBeInTheDocument()
  })
})
