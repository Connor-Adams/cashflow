import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { ToastProvider } from '@/components/ui/toast'
import { GoalsPage } from './GoalsPage'
import { getJson } from '../lib/api'

// GoalsPage loads goals + accounts through getJson; postJson/deleteReq are
// stubbed. Default impl resolves empty so the page renders its empty state.
vi.mock('../lib/api', () => ({
  getJson: vi.fn((url: string) => {
    if (url.includes('/api/accounts')) return Promise.resolve([])
    if (url.includes('/api/goals')) return Promise.resolve({ data: [] })
    return Promise.resolve({})
  }),
  postJson: vi.fn(() => Promise.resolve({})),
  deleteReq: vi.fn(() => Promise.resolve(undefined)),
}))

function renderPage() {
  return render(
    <MemoryRouter>
      <ToastProvider>
        <GoalsPage />
      </ToastProvider>
    </MemoryRouter>,
  )
}

describe('GoalsPage', () => {
  it('renders the page heading', async () => {
    renderPage()
    expect(
      await screen.findByRole('heading', { name: /^goals$/i }),
    ).toBeInTheDocument()
  })

  it('renders a populated goal name', async () => {
    vi.mocked(getJson).mockImplementation((url: string) => {
      if (url.includes('/api/accounts')) return Promise.resolve([])
      if (url.includes('/projection')) return Promise.resolve({})
      if (url.includes('/api/goals'))
        return Promise.resolve({
          data: [
            {
              id: 1,
              name: 'Emergency fund',
              targetAmount: '5000',
              currentAmount: '1000',
              currency: 'CAD',
              targetDate: null,
              monthlyContribution: null,
              linkedAccountId: null,
              priority: 0,
              status: 'active',
              notes: null,
            },
          ],
        })
      return Promise.resolve({})
    })
    renderPage()
    expect(await screen.findByText('Emergency fund')).toBeInTheDocument()
  })

  it('renders skeletons while loading', () => {
    // Pin loading=true by making getJson never resolve, then restore the
    // resolving default so the heading test keeps rendering.
    const original = vi.mocked(getJson).getMockImplementation()
    vi.mocked(getJson).mockImplementation(() => new Promise(() => {}))
    try {
      const { container } = renderPage()
      expect(
        container.querySelectorAll('[data-slot="skeleton"]').length,
      ).toBeGreaterThan(0)
    } finally {
      vi.mocked(getJson).mockImplementation(original!)
    }
  })
})
