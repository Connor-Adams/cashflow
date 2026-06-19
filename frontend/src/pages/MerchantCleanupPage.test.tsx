import React from 'react'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { ToastProvider } from '@/components/ui/toast'
import { MerchantCleanupPage } from './MerchantCleanupPage'
import { getJson, postJson } from '../lib/api'

vi.mock('../lib/api', () => ({
  getJson: vi.fn(),
  postJson: vi.fn(),
}))

const mockGetJson = vi.mocked(getJson)
const mockPostJson = vi.mocked(postJson)

const CLUSTERS = [
  {
    merchantClean: 'TINY CAFE',
    canonical: 'Tiny Cafe',
    count: 4,
    totalSpend: '12.00',
    currency: 'CAD',
    dominantCategory: 'Coffee',
    categorySpread: [{ category: 'Coffee', count: 4 }],
    sampleDescriptions: ['TINY CAFE #1'],
  },
  {
    merchantClean: 'BLUE BOTTLE COFFEE',
    canonical: 'Blue Bottle Coffee',
    count: 41,
    totalSpend: '812.55',
    currency: 'CAD',
    dominantCategory: 'Coffee',
    categorySpread: [
      { category: 'Coffee', count: 38 },
      { category: 'Dining', count: 3 },
    ],
    sampleDescriptions: ['SQ *BLUE BOTTLE', 'BLUE BOTTLE COFFEE #12'],
  },
]

function defaultGet(path: string) {
  if (path === '/api/merchants/clusters') {
    return Promise.resolve({ clusters: CLUSTERS })
  }
  if (path === '/api/transactions/category-hints') {
    return Promise.resolve({ categories: [{ label: 'Coffee', usageCount: 5 }] })
  }
  return Promise.resolve({})
}

function renderPage() {
  return render(
    <ToastProvider>
      <MemoryRouter>
        <MerchantCleanupPage />
      </MemoryRouter>
    </ToastProvider>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  mockGetJson.mockImplementation(defaultGet as never)
  mockPostJson.mockResolvedValue({} as never)
})

describe('MerchantCleanupPage', () => {
  it('renders clusters sorted by spend (as returned) with the mixed indicator', async () => {
    renderPage()
    // Backend returns sorted-by-spend; the page renders that order verbatim.
    await screen.findByText('Blue Bottle Coffee')
    expect(screen.getByText('Tiny Cafe')).toBeTruthy()
    // mixed-category cluster shows the "mixed" badge
    expect(screen.getByText(/mixed \+1/)).toBeTruthy()
  })

  it('renders the empty state when there are no clusters', async () => {
    mockGetJson.mockImplementation(((path: string) => {
      if (path === '/api/merchants/clusters') return Promise.resolve({ clusters: [] })
      return defaultGet(path)
    }) as never)
    renderPage()
    await screen.findByText('No merchants to clean up yet')
  })

  it('renders the error state with a Retry control when the fetch fails', async () => {
    mockGetJson.mockImplementation(((path: string) => {
      if (path === '/api/merchants/clusters') return Promise.reject(new Error('boom'))
      return defaultGet(path)
    }) as never)
    renderPage()
    await screen.findByText(/couldn't load your merchants/i)
    const retry = screen.getByRole('button', { name: /retry/i })
    expect(retry).toBeTruthy()
  })

  it('Apply category posts bulk-recategorize for the cluster', async () => {
    mockPostJson.mockResolvedValue({ recategorized: 4, ruleCreated: false, ruleId: null } as never)
    renderPage()
    await screen.findByText('Tiny Cafe')
    // First "Apply category" button corresponds to the first row.
    const applyButtons = screen.getAllByRole('button', { name: 'Apply category' })
    fireEvent.click(applyButtons[0])
    await waitFor(() => {
      expect(mockPostJson).toHaveBeenCalledWith(
        '/api/merchants/bulk-recategorize',
        expect.objectContaining({ merchantClean: 'TINY CAFE', createRule: false }),
      )
    })
  })

  it('Create rule posts bulk-recategorize with createRule true', async () => {
    mockPostJson.mockResolvedValue({ recategorized: 4, ruleCreated: true, ruleId: 9 } as never)
    renderPage()
    await screen.findByText('Tiny Cafe')
    const createButtons = screen.getAllByRole('button', { name: 'Create rule' })
    fireEvent.click(createButtons[0])
    await waitFor(() => {
      expect(mockPostJson).toHaveBeenCalledWith(
        '/api/merchants/bulk-recategorize',
        expect.objectContaining({ merchantClean: 'TINY CAFE', createRule: true }),
      )
    })
  })

  it('merge confirm dialog shows the affected-transaction count before applying', async () => {
    mockPostJson.mockResolvedValue({ reassigned: 45, survivor: 'Tiny Cafe' } as never)
    renderPage()
    await screen.findByText('Tiny Cafe')
    // Select both rows.
    fireEvent.click(screen.getByLabelText('Select TINY CAFE'))
    fireEvent.click(screen.getByLabelText('Select BLUE BOTTLE COFFEE'))
    // The "Merge selected (2)" action appears in the header.
    const mergeBtn = await screen.findByRole('button', { name: /merge selected/i })
    fireEvent.click(mergeBtn)
    // Confirm dialog states 4 + 41 = 45 affected transactions.
    await screen.findByText(/reassigns 45 transactions/i)
    // Confirm merge.
    fireEvent.click(screen.getByRole('button', { name: 'Merge merchants' }))
    await waitFor(() => {
      expect(mockPostJson).toHaveBeenCalledWith(
        '/api/merchants/merge',
        expect.objectContaining({ mergeMerchantCleans: expect.any(Array) }),
      )
    })
  })
})
