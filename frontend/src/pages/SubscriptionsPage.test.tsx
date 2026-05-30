import React from 'react'
import { render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ToastProvider } from '@/components/ui/toast'
import { SubscriptionsPage } from './SubscriptionsPage'

/**
 * Frontend coverage for the editable-cadence + cancel-impact feature (#291).
 * AC #6 (cadence dropdown with 5 values), #7 (cadence change PATCH + impact
 * refetch), #9 (horizon change refetches), #10 (cancel confirm shows impact),
 * #11 (cancelled rows lock cadence + hide impact card).
 */

const ACTIVE_SUB = {
  id: 1,
  householdId: 1,
  merchantName: 'Netflix',
  normalizedName: 'netflix',
  amount: '20.0000',
  currency: 'CAD',
  cadence: 'monthly',
  lastChargeDate: '2026-05-01',
  nextExpectedDate: '2026-06-01',
  status: 'active',
  category: 'Streaming',
  annualizedCost: '240.0000',
  priceChangeDetected: false,
  cancellationUrl: null,
  notes: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-05-01T00:00:00.000Z',
}

const CANCELLED_SUB = {
  ...ACTIVE_SUB,
  id: 2,
  merchantName: 'Spotify',
  normalizedName: 'spotify',
  amount: '10.0000',
  annualizedCost: '120.0000',
  status: 'cancelled',
}

const SUMMARY_PAYLOAD = {
  totals: { active: 1, ignored: 0, cancelled: 1, unknown: 0, priceChangeDetected: 0 },
  byCurrency: [{ currency: 'CAD', activeCount: 1, monthlyCost: 20, annualCost: 240 }],
}

function jsonResponse(body: unknown) {
  return Promise.resolve({
    ok: true,
    status: 200,
    text: () => Promise.resolve(JSON.stringify(body)),
    json: () => Promise.resolve(body),
    headers: { get: () => null },
  } as unknown as Response)
}

type FetchMock = ReturnType<typeof vi.fn>

function installFetch(items: unknown[] = [ACTIVE_SUB, CANCELLED_SUB]): FetchMock {
  const fetchMock = vi.fn((input: RequestInfo, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    if (url.includes('/api/subscriptions/summary')) {
      return jsonResponse(SUMMARY_PAYLOAD)
    }
    // cancel-impact: echo the requested horizon so the test can assert refetch.
    const impactMatch = url.match(/\/api\/subscriptions\/(\d+)\/cancel-impact\?horizonMonths=(\d+)/)
    if (impactMatch) {
      const horizon = Number(impactMatch[2])
      // $20/mo over N months → amount = 20 * N, count = N.
      return jsonResponse({
        amount: 20 * horizon,
        currency: 'CAD',
        count: horizon,
        horizonMonths: horizon,
      })
    }
    // PATCH a single subscription — reflect the patched fields back.
    const patchMatch = url.match(/\/api\/subscriptions\/(\d+)$/)
    if (patchMatch && method === 'PATCH') {
      const body = init?.body ? JSON.parse(String(init.body)) : {}
      return jsonResponse({ ...ACTIVE_SUB, id: Number(patchMatch[1]), ...body })
    }
    if (url.includes('/api/subscriptions')) {
      return jsonResponse({ items })
    }
    return jsonResponse({})
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

function renderPage() {
  return render(
    <ToastProvider>
      <MemoryRouter>
        <SubscriptionsPage />
      </MemoryRouter>
    </ToastProvider>,
  )
}

describe('SubscriptionsPage cadence + cancel impact (#291)', () => {
  beforeEach(() => {
    installFetch()
  })

  it('renders a cadence dropdown with the five cadence values for an active row (AC #6)', async () => {
    renderPage()
    const select = (await screen.findByLabelText(
      'Cadence for Netflix',
    )) as HTMLSelectElement
    const optionLabels = Array.from(select.options).map((o) => o.textContent)
    expect(optionLabels).toEqual([
      'Weekly',
      'Monthly',
      'Quarterly',
      'Semi-annual',
      'Annual',
    ])
    expect(select.value).toBe('monthly')
  })

  it('PATCHes the new cadence when the dropdown changes (AC #7)', async () => {
    const fetchMock = installFetch()
    const { default: userEvent } = await import('@testing-library/user-event')
    const user = userEvent.setup()
    renderPage()

    const select = await screen.findByLabelText('Cadence for Netflix')
    await user.selectOptions(select, 'annual')

    await waitFor(() => {
      const patchCall = fetchMock.mock.calls.find(([url, init]) => {
        return (
          String(url).match(/\/api\/subscriptions\/1$/) &&
          (init as RequestInit | undefined)?.method === 'PATCH'
        )
      })
      expect(patchCall).toBeTruthy()
      const body = JSON.parse(String((patchCall![1] as RequestInit).body))
      expect(body.cadence).toBe('annual')
    })
  })

  it('shows the cancel-impact card with savings copy when the row impact is opened (AC #8)', async () => {
    const { default: userEvent } = await import('@testing-library/user-event')
    const user = userEvent.setup()
    renderPage()

    await screen.findByLabelText('Cadence for Netflix')
    await user.click(screen.getByRole('button', { name: /cancel impact/i }))

    await screen.findByText('If you cancel')
    // $20/mo over the default 12-month horizon → $240.
    await waitFor(() =>
      expect(screen.getByText(/Cancelling saves you/i)).toBeInTheDocument(),
    )
    expect(screen.getByText(/over the next 12 months/i)).toBeInTheDocument()
  })

  it('refetches cancel-impact when the horizon changes (AC #9)', async () => {
    const fetchMock = installFetch()
    const { default: userEvent } = await import('@testing-library/user-event')
    const user = userEvent.setup()
    renderPage()

    await screen.findByLabelText('Cadence for Netflix')
    await user.click(screen.getByRole('button', { name: /cancel impact/i }))

    const horizonSelect = await screen.findByLabelText('Cancel impact horizon')
    await user.selectOptions(horizonSelect, '24')

    await waitFor(() => {
      const call24 = fetchMock.mock.calls.find(([url]) =>
        String(url).includes('cancel-impact?horizonMonths=24'),
      )
      expect(call24).toBeTruthy()
    })
    await waitFor(() =>
      expect(screen.getByText(/over the next 24 months/i)).toBeInTheDocument(),
    )
  })

  it('shows a confirm dialog with the cancel-impact figure when marking cancelled (AC #10)', async () => {
    const { default: userEvent } = await import('@testing-library/user-event')
    const user = userEvent.setup()
    renderPage()

    await screen.findByLabelText('Cadence for Netflix')
    await user.click(screen.getByRole('button', { name: 'mark cancelled' }))

    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('Cancel Netflix?')).toBeInTheDocument()
    await waitFor(() =>
      expect(within(dialog).getByText(/This saves .* but you lose Netflix/i)).toBeInTheDocument(),
    )
  })

  it('locks the cadence and hides the impact action for cancelled rows (AC #11)', async () => {
    renderPage()
    await screen.findByLabelText('Cadence for Netflix')
    // Spotify (id 2) is cancelled: no editable cadence dropdown.
    expect(screen.queryByLabelText('Cadence for Spotify')).not.toBeInTheDocument()
    // Its cadence renders as a static badge inside the Spotify row.
    const spotifyRow = screen.getByText('Spotify').closest('tr') as HTMLElement
    expect(within(spotifyRow).getByText('Monthly')).toBeInTheDocument()
    expect(within(spotifyRow).queryByRole('combobox')).not.toBeInTheDocument()
    // The cancelled row exposes no "cancel impact" toggle.
    expect(
      within(spotifyRow).queryByRole('button', { name: /cancel impact/i }),
    ).not.toBeInTheDocument()
    // Only the active row exposes a "cancel impact" toggle (one button total).
    expect(screen.getAllByRole('button', { name: /cancel impact/i })).toHaveLength(1)
  })
})
