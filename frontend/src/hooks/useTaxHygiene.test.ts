import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { useTaxSummary, useMissingReceipts, patchTransactionTax, type TaxHygieneFilters } from './useTaxHygiene'
import * as api from '@/lib/api'

void React

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return { ...actual, getJson: vi.fn(), patchJson: vi.fn(), postJson: vi.fn() }
})

const filters: TaxHygieneFilters = { scope: 'business', from: '2026-01-01', to: '2026-12-31' }

beforeEach(() => {
  vi.clearAllMocks()
})

describe('useTaxSummary', () => {
  it('builds the right query string', async () => {
    vi.mocked(api.getJson).mockResolvedValue({ data: [], scope: 'business' })
    const { result } = renderHook(() => useTaxSummary(filters))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(api.getJson).toHaveBeenCalledWith(
      '/api/business/tax-summary?scope=business&from=2026-01-01&to=2026-12-31',
    )
  })

  it('returns data on success', async () => {
    vi.mocked(api.getJson).mockResolvedValue({
      data: [
        {
          currency: 'CAD',
          gross: '100.00',
          deductibleEstimate: '100.00',
          hstGstEstimate: '13.00',
          transactionCount: 1,
          reviewedCount: 0,
        },
      ],
      scope: 'business',
    })
    const { result } = renderHook(() => useTaxSummary(filters))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.data?.data).toHaveLength(1)
    expect(result.current.error).toBe(null)
  })

  it('sets error state on failure', async () => {
    vi.mocked(api.getJson).mockRejectedValue(new Error('boom'))
    const { result } = renderHook(() => useTaxSummary(filters))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.error).toBe('boom')
  })

  it('omits empty from/to', async () => {
    vi.mocked(api.getJson).mockResolvedValue({ data: [], scope: 'all' })
    const { result } = renderHook(() => useTaxSummary({ scope: 'all' }))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(api.getJson).toHaveBeenCalledWith('/api/business/tax-summary?scope=all')
  })
})

describe('useMissingReceipts', () => {
  it('hits the correct endpoint with scope filters', async () => {
    vi.mocked(api.getJson).mockResolvedValue({ data: [], count: 0 })
    const { result } = renderHook(() => useMissingReceipts(filters))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(api.getJson).toHaveBeenCalledWith(
      '/api/business/missing-receipts?scope=business&from=2026-01-01&to=2026-12-31',
    )
    expect(result.current.data?.count).toBe(0)
  })
})

describe('patchTransactionTax', () => {
  it('PATCHes the tax sub-endpoint and returns the metadata payload', async () => {
    vi.mocked(api.patchJson).mockResolvedValue({
      data: {
        transactionId: 7,
        taxTagId: 1,
        taxTag: { id: 1, name: 'Office' },
        deductiblePercent: '1.0000',
        hstGstAmount: null,
        receiptRequired: true,
        reviewedForTax: true,
      },
    })
    const meta = await patchTransactionTax(7, { reviewedForTax: true })
    expect(api.patchJson).toHaveBeenCalledWith('/api/transactions/7/tax', { reviewedForTax: true })
    expect(meta.reviewedForTax).toBe(true)
    expect(meta.taxTag?.name).toBe('Office')
  })
})
