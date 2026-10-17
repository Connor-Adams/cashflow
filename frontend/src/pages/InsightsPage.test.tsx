import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { InsightsPage } from './InsightsPage'

type FakeInsight = {
  id: number
  type: string
  severity: 'info' | 'warning' | 'critical'
  title: string
  description: string | null
  entityType: string | null
  entityId: number | null
  status: 'open' | 'dismissed' | 'resolved'
  metadata: unknown
  detectedAt: string
  createdAt: string
  updatedAt: string
}

function makeRow(p: Partial<FakeInsight>): FakeInsight {
  return {
    id: 1,
    type: 'duplicate_transactions',
    severity: 'warning',
    title: 'Possible duplicate at Costco',
    description: '2 charges of 50.00 CAD',
    entityType: 'transaction',
    entityId: 99,
    status: 'open',
    metadata: {},
    detectedAt: '2026-05-10T12:00:00Z',
    createdAt: '2026-05-10T12:00:00Z',
    updatedAt: '2026-05-10T12:00:00Z',
    ...p,
  }
}

beforeEach(() => {
  vi.restoreAllMocks()
})

afterEach(() => {
  cleanup()
})

function mockApi(items: FakeInsight[]) {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString()
    if (url.endsWith('/api/insights') && (!init || !init.method || init.method === 'GET')) {
      return new Response(JSON.stringify({ data: items }), { status: 200 })
    }
    if (url.endsWith('/api/insights/run')) {
      return new Response(JSON.stringify({ created: 0, refreshed: 0, total: 0 }), { status: 200 })
    }
    if (url.match(/\/api\/insights\/\d+$/) && init?.method === 'PATCH') {
      const body = JSON.parse(String(init.body))
      const id = Number(url.split('/').pop())
      const original = items.find((i) => i.id === id) || items[0]
      return new Response(JSON.stringify({ ...original, status: body.status }), { status: 200 })
    }
    return new Response('not found', { status: 404 })
  })
}

describe('InsightsPage', () => {
  it('renders the "No insights yet" EmptyState with a Run detectors CTA when there are no items (#799)', async () => {
    mockApi([])
    render(
      <MemoryRouter>
        <InsightsPage />
      </MemoryRouter>,
    )
    await waitFor(() => expect(screen.getByText('No insights yet')).toBeTruthy())
    // CTA lives inside the empty state (there is also a header "Run detectors"
    // button — the empty state adds a second one in its actions slot).
    expect(
      screen.getAllByRole('button', { name: /run detectors/i }).length,
    ).toBeGreaterThan(0)
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Insights')
  })

  it('renders a "Nothing matches this filter" EmptyState when data exists but the active tab is empty (#799)', async () => {
    // One resolved row → the default "open" tab is empty even though data exists.
    mockApi([makeRow({ id: 1, status: 'resolved', title: 'Done one' })])
    render(
      <MemoryRouter>
        <InsightsPage />
      </MemoryRouter>,
    )
    await waitFor(() => expect(screen.getByText('Nothing matches this filter')).toBeTruthy())
    expect(screen.getByRole('button', { name: /clear filters/i })).toBeTruthy()
  })

  it('sorts items by severity (critical, warning, info)', async () => {
    mockApi([
      makeRow({ id: 1, severity: 'info', title: 'Low' }),
      makeRow({ id: 2, severity: 'critical', title: 'High' }),
      makeRow({ id: 3, severity: 'warning', title: 'Mid' }),
    ])
    render(
      <MemoryRouter>
        <InsightsPage />
      </MemoryRouter>,
    )
    const rows = await waitFor(() => {
      const found = screen.getAllByTestId('insight-row')
      if (found.length < 3) throw new Error('not yet rendered')
      return found
    })
    expect(rows[0].textContent).toContain('High')
    expect(rows[1].textContent).toContain('Mid')
    expect(rows[2].textContent).toContain('Low')
  })

  it('shows counts per status tab', async () => {
    mockApi([
      makeRow({ id: 1, status: 'open' }),
      makeRow({ id: 2, status: 'open' }),
      makeRow({ id: 3, status: 'dismissed' }),
    ])
    render(
      <MemoryRouter>
        <InsightsPage />
      </MemoryRouter>,
    )
    const openBtn = await waitFor(() => screen.getByRole('button', { name: /^Open \(2\)/ }))
    expect(openBtn).toBeTruthy()
    const dismissedBtn = screen.getByRole('button', { name: /^Dismissed \(1\)/ })
    expect(dismissedBtn).toBeTruthy()
    const resolvedBtn = screen.getByRole('button', { name: /^Resolved \(0\)/ })
    expect(resolvedBtn).toBeTruthy()
  })

  it('dismisses an open insight via PATCH (optimistic update)', async () => {
    mockApi([makeRow({ id: 42, status: 'open', title: 'Open thing' })])
    render(
      <MemoryRouter>
        <InsightsPage />
      </MemoryRouter>,
    )
    const dismissBtn = await waitFor(() => screen.getByRole('button', { name: 'Dismiss' }))
    fireEvent.click(dismissBtn)
    // After dismissing, the row should disappear from the Open tab
    await waitFor(() => {
      const rows = screen.queryAllByTestId('insight-row')
      expect(rows.length).toBe(0)
    })
  })

  it('renders View link only when entityType is present', async () => {
    mockApi([
      makeRow({ id: 1, title: 'With link', entityType: 'transaction', entityId: 5 }),
      makeRow({ id: 2, title: 'No entity', entityType: null, entityId: null }),
    ])
    render(
      <MemoryRouter>
        <InsightsPage />
      </MemoryRouter>,
    )
    const rows = await waitFor(() => {
      const found = screen.getAllByTestId('insight-row')
      if (found.length < 2) throw new Error('not yet rendered')
      return found
    })
    // Locate each row by content (sort is by severity, then id desc — id-sensitive)
    const withLinkRow = rows.find((r) => r.textContent?.includes('With link'))
    const noEntityRow = rows.find((r) => r.textContent?.includes('No entity'))
    expect(withLinkRow).toBeTruthy()
    expect(noEntityRow).toBeTruthy()
    expect(withLinkRow!.querySelector('a')).toBeTruthy()
    expect(noEntityRow!.querySelector('a')).toBeNull()
  })

  it('reopens a dismissed insight when on the Dismissed tab', async () => {
    mockApi([makeRow({ id: 7, status: 'dismissed', title: 'Was dismissed' })])
    render(
      <MemoryRouter>
        <InsightsPage />
      </MemoryRouter>,
    )
    const dismissedTab = await waitFor(() =>
      screen.getByRole('button', { name: /^Dismissed \(1\)/ }),
    )
    fireEvent.click(dismissedTab)
    const reopenBtn = await waitFor(() => screen.getByRole('button', { name: 'Reopen' }))
    fireEvent.click(reopenBtn)
    await waitFor(() => {
      // After reopening, the row leaves the Dismissed tab (tab still has count 0
      // because state mutated optimistically).
      expect(screen.queryAllByTestId('insight-row').length).toBe(0)
    })
  })

  describe('evidence (#insight-evidence)', () => {
    it('renders the matched transactions for duplicate_transactions, collapsed by default', async () => {
      mockApi([
        makeRow({
          id: 1,
          type: 'duplicate_transactions',
          metadata: { transactionIds: [10, 11], merchant: 'Costco', amount: 50, currency: 'CAD' },
        }),
      ])
      render(
        <MemoryRouter>
          <InsightsPage />
        </MemoryRouter>,
      )
      const summary = await waitFor(() =>
        screen.getByText(/2 matched charges of \$50\.00 each · total \$100\.00/),
      )
      const details = summary.closest('details')
      expect(details).toBeTruthy()
      expect(details!.hasAttribute('open')).toBe(false)
      expect(screen.getByText('Transaction #10')).toBeTruthy()
      expect(screen.getByText('Transaction #11')).toBeTruthy()
      fireEvent.click(summary)
      expect(details!.hasAttribute('open')).toBe(true)
    })

    it('renders the before/after pair for merchant_spend_spike', async () => {
      mockApi([
        makeRow({
          id: 1,
          type: 'merchant_spend_spike',
          metadata: {
            merchant: 'Amazon',
            currency: 'CAD',
            currentMonth: '2026-05',
            currentAmount: 300,
            priorAvg: 100,
            multiplier: 3,
          },
        }),
      ])
      render(
        <MemoryRouter>
          <InsightsPage />
        </MemoryRouter>,
      )
      await waitFor(() =>
        expect(
          screen.getByText(/\$100\.00\/mo avg → \$300\.00 this month \(\+\$200\.00, 3\.0×\)/),
        ).toBeTruthy(),
      )
    })

    it('renders the before/after pair for recurring_increase', async () => {
      mockApi([
        makeRow({
          id: 1,
          type: 'recurring_increase',
          metadata: {
            merchant: 'Netflix',
            currency: 'CAD',
            priorAmount: 15,
            currentAmount: 20,
            currentMonth: '2026-05',
          },
        }),
      ])
      render(
        <MemoryRouter>
          <InsightsPage />
        </MemoryRouter>,
      )
      await waitFor(() =>
        expect(screen.getByText(/\$15\.00\/mo → \$20\.00 this month \(\+\$5\.00\)/)).toBeTruthy(),
      )
    })

    it('renders the before/after pair for unusual_category_spend', async () => {
      mockApi([
        makeRow({
          id: 1,
          type: 'unusual_category_spend',
          metadata: {
            category: 'Dining',
            currency: 'CAD',
            currentMonth: '2026-05',
            currentAmount: 400,
            priorAvg: 150,
            multiplier: 2.67,
          },
        }),
      ])
      render(
        <MemoryRouter>
          <InsightsPage />
        </MemoryRouter>,
      )
      await waitFor(() =>
        expect(
          screen.getByText(/\$150\.00\/mo avg → \$400\.00 this month \(\+\$250\.00, 2\.7×\)/),
        ).toBeTruthy(),
      )
    })

    it('renders a tight one-line evidence for missing_receipt with a transaction link', async () => {
      mockApi([
        makeRow({
          id: 1,
          type: 'missing_receipt',
          metadata: {
            transactionId: 77,
            amount: 65.5,
            currency: 'CAD',
            merchant: 'Best Buy',
            date: '2026-05-01',
          },
        }),
      ])
      render(
        <MemoryRouter>
          <InsightsPage />
        </MemoryRouter>,
      )
      const link = await waitFor(() => screen.getByText(/Best Buy · \$65\.50 · 2026-05-01/))
      expect(link.closest('a')?.getAttribute('href')).toBe('/transactions?ids=77')
    })

    it('renders the triggering numbers for cash_runway_low', async () => {
      mockApi([
        makeRow({
          id: 1,
          type: 'cash_runway_low',
          metadata: {
            currency: 'CAD',
            crossingDate: '2026-06-01',
            projectedBalance: -50,
            buffer: 0,
            daysOut: 10,
            horizonDays: 30,
          },
        }),
      ])
      render(
        <MemoryRouter>
          <InsightsPage />
        </MemoryRouter>,
      )
      await waitFor(() =>
        expect(
          screen.getByText(
            /Projected balance -\$50\.00 on 2026-06-01 — below buffer \$0\.00 within 30d/,
          ),
        ).toBeTruthy(),
      )
    })

    it('renders a compact month → amount trail (and sparkline) for category_trend', async () => {
      mockApi([
        makeRow({
          id: 1,
          type: 'category_trend',
          metadata: {
            category: 'Groceries',
            currency: 'CAD',
            windowEndMonth: '2026-05',
            monthlyTotals: [100, 130, 180],
            risePct: 80,
          },
        }),
      ])
      render(
        <MemoryRouter>
          <InsightsPage />
        </MemoryRouter>,
      )
      await waitFor(() =>
        expect(
          screen.getByText('2026-03: $100.00 → 2026-04: $130.00 → 2026-05: $180.00'),
        ).toBeTruthy(),
      )
      // A tiny inline sparkline SVG accompanies the trail.
      expect(document.querySelector('svg')).toBeTruthy()
    })

    it('renders the net amount for settlement_imbalance', async () => {
      mockApi([
        makeRow({
          id: 1,
          type: 'settlement_imbalance',
          metadata: {
            contactId: 5,
            contactName: 'Sam',
            currency: 'CAD',
            netAmount: 250,
            direction: 'partner_owes_you',
          },
        }),
      ])
      render(
        <MemoryRouter>
          <InsightsPage />
        </MemoryRouter>,
      )
      await waitFor(() =>
        expect(screen.getByText('Net $250.00 (partner owes you)')).toBeTruthy(),
      )
    })

    it('renders the before/after pair for subscription_price_increase, linked to the triggering transaction', async () => {
      mockApi([
        makeRow({
          id: 1,
          type: 'subscription_price_increase',
          metadata: {
            previousAmountCents: 1500,
            newAmountCents: 1800,
            pctChange: 20,
            triggeringTransactionId: 88,
            currency: 'CAD',
          },
        }),
      ])
      render(
        <MemoryRouter>
          <InsightsPage />
        </MemoryRouter>,
      )
      const link = await waitFor(() => screen.getByText(/\$15\.00 → \$18\.00/))
      expect(link.closest('a')?.getAttribute('href')).toBe('/transactions?ids=88')
      expect(screen.getByText(/\(\+20%\)/)).toBeTruthy()
    })

    it('falls back to the money-leak snapshot shape for a dismissed subscription_price_increase', async () => {
      mockApi([
        makeRow({
          id: 1,
          type: 'subscription_price_increase',
          status: 'dismissed',
          metadata: { title: 'Netflix price hike', currency: 'CAD', monthlyImpact: 3, annualImpact: 36 },
        }),
      ])
      render(
        <MemoryRouter>
          <InsightsPage />
        </MemoryRouter>,
      )
      const dismissedTab = await waitFor(() =>
        screen.getByRole('button', { name: /^Dismissed \(1\)/ }),
      )
      fireEvent.click(dismissedTab)
      await waitFor(() => expect(screen.getByText('$3.00/mo · $36.00/yr')).toBeTruthy())
    })

    it.each(['small_subscription', 'recurring_fee', 'duplicate_service', 'delivery_fee_high'] as const)(
      'renders the money-leak snapshot for a dismissed %s insight',
      async (leakType) => {
        mockApi([
          makeRow({
            id: 1,
            type: leakType,
            status: 'dismissed',
            metadata: {
              title: 'Some leak',
              currency: 'CAD',
              monthlyImpact: 12,
              annualImpact: 144,
            },
          }),
        ])
        render(
          <MemoryRouter>
            <InsightsPage />
          </MemoryRouter>,
        )
        const dismissedTab = await waitFor(() =>
          screen.getByRole('button', { name: /^Dismissed \(1\)/ }),
        )
        fireEvent.click(dismissedTab)
        await waitFor(() => expect(screen.getByText('$12.00/mo · $144.00/yr')).toBeTruthy())
      },
    )

    describe('enriched evidence (priorMonths / contributing transactions / threshold)', () => {
      it('renders a legible single-month baseline when priorMonths has exactly one entry', async () => {
        mockApi([
          makeRow({
            id: 1,
            type: 'merchant_spend_spike',
            metadata: {
              merchant: 'LCBO/RAO',
              currency: 'CAD',
              currentMonth: '2026-05',
              currentAmount: 97.8,
              priorAvg: 31.8,
              multiplier: 3.08,
              priorMonths: [{ month: '2026-04', amount: 31.8 }],
              currentIds: [501],
              currentIdsTotal: 1,
              threshold: { multiplier: 2, minCurrent: 100 },
            },
          }),
        ])
        render(
          <MemoryRouter>
            <InsightsPage />
          </MemoryRouter>,
        )
        await waitFor(() => expect(screen.getByText(/Apr \$31\.80 → May \$97\.80/)).toBeTruthy())
        expect(screen.getByText(/based on 1 prior month/)).toBeTruthy()
      })

      it('renders the full trail for a 3-entry priorMonths (no single-month caveat)', async () => {
        mockApi([
          makeRow({
            id: 1,
            type: 'recurring_increase',
            metadata: {
              merchant: 'Netflix',
              currency: 'CAD',
              priorAmount: 15,
              currentAmount: 20,
              currentMonth: '2026-05',
              priorMonths: [
                { month: '2026-02', amount: 15 },
                { month: '2026-03', amount: 15 },
                { month: '2026-04', amount: 15 },
              ],
              supportingTransactionIds: [900],
              supportingTransactionIdsTotal: 1,
              threshold: { ratio: 1.2 },
            },
          }),
        ])
        render(
          <MemoryRouter>
            <InsightsPage />
          </MemoryRouter>,
        )
        await waitFor(() =>
          expect(
            screen.getByText('Feb $15.00 → Mar $15.00 → Apr $15.00 → May $20.00'),
          ).toBeTruthy(),
        )
        expect(screen.queryByText(/based on 1 prior month/)).toBeNull()
      })

      it('falls back to the old before/after rendering for an OLD-shape merchant_spend_spike row with no priorMonths (regression guard)', async () => {
        mockApi([
          makeRow({
            id: 1,
            type: 'merchant_spend_spike',
            metadata: {
              // Exactly the pre-enrichment shape: no priorMonths / currentIds /
              // threshold, only what ~153 production rows already have.
              merchant: 'Amazon',
              currency: 'CAD',
              currentMonth: '2026-05',
              currentAmount: 300,
              priorAvg: 100,
              multiplier: 3,
            },
          }),
        ])
        render(
          <MemoryRouter>
            <InsightsPage />
          </MemoryRouter>,
        )
        await waitFor(() =>
          expect(
            screen.getByText(/\$100\.00\/mo avg → \$300\.00 this month \(\+\$200\.00, 3\.0×\)/),
          ).toBeTruthy(),
        )
        expect(screen.queryByText(/based on 1 prior month/)).toBeNull()
      })

      it('does not throw and falls back to the old rendering when priorMonths/currentIds/threshold are malformed', async () => {
        mockApi([
          makeRow({
            id: 1,
            type: 'merchant_spend_spike',
            metadata: {
              merchant: 'Amazon',
              currency: 'CAD',
              currentAmount: 300,
              priorAvg: 100,
              multiplier: 3,
              priorMonths: 'not-an-array',
              currentIds: 'nope',
              currentIdsTotal: 'nope',
              threshold: 'nope',
            },
          }),
        ])
        expect(() =>
          render(
            <MemoryRouter>
              <InsightsPage />
            </MemoryRouter>,
          ),
        ).not.toThrow()
        await waitFor(() =>
          expect(
            screen.getByText(/\$100\.00\/mo avg → \$300\.00 this month \(\+\$200\.00, 3\.0×\)/),
          ).toBeTruthy(),
        )
      })

      it('renders "and N more" for a capped contributing-transaction list using the *Total count', async () => {
        mockApi([
          makeRow({
            id: 1,
            type: 'merchant_spend_spike',
            metadata: {
              merchant: 'Amazon',
              currency: 'CAD',
              currentMonth: '2026-05',
              currentAmount: 300,
              priorAvg: 100,
              multiplier: 3,
              priorMonths: [{ month: '2026-04', amount: 100 }],
              currentIds: [1, 2],
              currentIdsTotal: 5,
            },
          }),
        ])
        render(
          <MemoryRouter>
            <InsightsPage />
          </MemoryRouter>,
        )
        await waitFor(() => expect(screen.getByText('5 contributing transactions')).toBeTruthy())
        expect(screen.getByText('Transaction #1')).toBeTruthy()
        expect(screen.getByText('Transaction #2')).toBeTruthy()
        expect(screen.getByText('and 3 more')).toBeTruthy()
      })

      it('renders the threshold rule for merchant_spend_spike', async () => {
        mockApi([
          makeRow({
            id: 1,
            type: 'merchant_spend_spike',
            metadata: {
              merchant: 'Amazon',
              currency: 'CAD',
              currentMonth: '2026-05',
              currentAmount: 300,
              priorAvg: 100,
              multiplier: 3,
              priorMonths: [{ month: '2026-04', amount: 100 }],
              threshold: { multiplier: 2, minCurrent: 100 },
            },
          }),
        ])
        render(
          <MemoryRouter>
            <InsightsPage />
          </MemoryRouter>,
        )
        await waitFor(() =>
          expect(
            screen.getByText(/Flagged because this month is over 2× the prior average and above \$100\.00\./),
          ).toBeTruthy(),
        )
      })

      it('renders the threshold rule for recurring_increase', async () => {
        mockApi([
          makeRow({
            id: 1,
            type: 'recurring_increase',
            metadata: {
              merchant: 'Netflix',
              currency: 'CAD',
              priorAmount: 15,
              currentAmount: 20,
              currentMonth: '2026-05',
              priorMonths: [
                { month: '2026-02', amount: 15 },
                { month: '2026-03', amount: 15 },
                { month: '2026-04', amount: 15 },
              ],
              threshold: { ratio: 1.2 },
            },
          }),
        ])
        render(
          <MemoryRouter>
            <InsightsPage />
          </MemoryRouter>,
        )
        await waitFor(() =>
          expect(
            screen.getByText(/Flagged because this month is at least 20% above the prior average\./),
          ).toBeTruthy(),
        )
      })

      it('renders the matched rows and threshold rule for duplicate_transactions with the enriched shape', async () => {
        mockApi([
          makeRow({
            id: 1,
            type: 'duplicate_transactions',
            metadata: {
              transactionIds: [10, 11],
              merchant: 'Costco',
              amount: 50,
              currency: 'CAD',
              transactions: [
                { id: 10, date: '2026-05-01', amount: 50 },
                { id: 11, date: '2026-05-02', amount: 50 },
              ],
              threshold: { windowDays: 3 },
            },
          }),
        ])
        render(
          <MemoryRouter>
            <InsightsPage />
          </MemoryRouter>,
        )
        await waitFor(() => expect(screen.getByText('2026-05-01 · $50.00')).toBeTruthy())
        expect(screen.getByText('2026-05-02 · $50.00')).toBeTruthy()
        expect(screen.getByText(/Flagged because the charges matched within 3 days\./)).toBeTruthy()
      })

      it('renders the threshold rule for category_trend', async () => {
        mockApi([
          makeRow({
            id: 1,
            type: 'category_trend',
            metadata: {
              category: 'Groceries',
              currency: 'CAD',
              windowEndMonth: '2026-05',
              monthlyTotals: [100, 130, 180],
              risePct: 80,
              threshold: { ratio: 0.25, warningRatio: 0.4, minAmount: 100 },
            },
          }),
        ])
        render(
          <MemoryRouter>
            <InsightsPage />
          </MemoryRouter>,
        )
        await waitFor(() =>
          expect(
            screen.getByText(
              /Flagged because spend rose at least 25% over the window and the latest month is above \$100\.00\./,
            ),
          ).toBeTruthy(),
        )
      })

      it('renders the threshold rule for cash_runway_low', async () => {
        mockApi([
          makeRow({
            id: 1,
            type: 'cash_runway_low',
            metadata: {
              currency: 'CAD',
              crossingDate: '2026-06-01',
              projectedBalance: -50,
              buffer: 0,
              daysOut: 10,
              horizonDays: 30,
              threshold: { horizonDays: 30, buffer: 0, criticalDays: 7 },
            },
          }),
        ])
        render(
          <MemoryRouter>
            <InsightsPage />
          </MemoryRouter>,
        )
        await waitFor(() =>
          expect(
            screen.getByText(
              /Flagged because the projected balance drops below \$0\.00 within 30 days \(critical inside 7 days\)\./,
            ),
          ).toBeTruthy(),
        )
      })

      it('renders the threshold rule for settlement_imbalance', async () => {
        mockApi([
          makeRow({
            id: 1,
            type: 'settlement_imbalance',
            metadata: {
              contactId: 5,
              contactName: 'Sam',
              currency: 'CAD',
              netAmount: 250,
              direction: 'partner_owes_you',
              threshold: { minNet: 100, criticalNet: 1000 },
            },
          }),
        ])
        render(
          <MemoryRouter>
            <InsightsPage />
          </MemoryRouter>,
        )
        await waitFor(() =>
          expect(
            screen.getByText(/Flagged because the net imbalance is above \$100\.00 \(critical above \$1,000\.00\)\./),
          ).toBeTruthy(),
        )
      })
    })

    it('renders no evidence block for an unrecognized insight type', async () => {
      mockApi([
        makeRow({
          id: 1,
          type: 'some_future_type',
          metadata: { anything: 'goes' },
        }),
      ])
      render(
        <MemoryRouter>
          <InsightsPage />
        </MemoryRouter>,
      )
      const row = await waitFor(() => screen.getByTestId('insight-row'))
      // Only the badge/title/description content should be present — no
      // evidence markup (no <details>, no extra <p> beyond the description).
      expect(row.querySelector('details')).toBeNull()
      expect(row.querySelectorAll('svg').length).toBe(0)
    })

    it.each([
      ['null metadata', null],
      ['string metadata', 'not an object'],
      ['metadata missing the expected keys', { merchant: 'Costco' }],
    ] as const)('renders nothing and does not throw for %s on a known type', async (_label, metadata) => {
      mockApi([
        makeRow({
          id: 1,
          type: 'duplicate_transactions',
          metadata,
        }),
      ])
      expect(() =>
        render(
          <MemoryRouter>
            <InsightsPage />
          </MemoryRouter>,
        ),
      ).not.toThrow()
      const row = await waitFor(() => screen.getByTestId('insight-row'))
      expect(row.querySelector('details')).toBeNull()
    })

    it('renders nothing and does not throw when category_trend.monthlyTotals is not an array', async () => {
      mockApi([
        makeRow({
          id: 1,
          type: 'category_trend',
          metadata: {
            category: 'Groceries',
            currency: 'CAD',
            windowEndMonth: '2026-05',
            monthlyTotals: 'not-an-array',
            risePct: 80,
          },
        }),
      ])
      expect(() =>
        render(
          <MemoryRouter>
            <InsightsPage />
          </MemoryRouter>,
        ),
      ).not.toThrow()
      const row = await waitFor(() => screen.getByTestId('insight-row'))
      expect(row.querySelectorAll('svg').length).toBe(0)
      expect(row.textContent).not.toContain('→')
    })
  })
})
