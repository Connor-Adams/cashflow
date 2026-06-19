import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { ToastProvider } from '@/components/ui/toast'
import { GoalsPage } from './GoalsPage'
import { getJson, postJson } from '../lib/api'

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

  it('blocks submit and shows an inline error for a negative target amount', async () => {
    // AC #6: negative amount → inline "Amount can't be negative." + no POST.
    vi.mocked(postJson).mockClear()
    const user = userEvent.setup()
    renderPage()
    const nameInput = await screen.findByPlaceholderText(
      /emergency fund, vacation/i,
    )
    await user.type(nameInput, 'Vacation')
    // A native number input still accepts a typed negative in real browsers;
    // jsdom's userEvent strips the leading '-', so set the raw value directly.
    const targetInput = screen.getByLabelText(/target amount/i)
    fireEvent.change(targetInput, { target: { value: '-100' } })
    fireEvent.submit(targetInput.closest('form')!)

    expect(await screen.findByText("Amount can't be negative.")).toBeInTheDocument()
    expect(vi.mocked(postJson)).not.toHaveBeenCalled()
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
