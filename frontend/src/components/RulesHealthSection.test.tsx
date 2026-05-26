import React from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { RulesHealthSection } from './RulesHealthSection'

const HEALTH = {
  windowDays: 90,
  totalRules: 12,
  totalTransactions: 200,
  hitCount: 150,
  hitRate: 0.75,
  uncategorizedCount: 8,
  reviewFlagCount: 3,
  staleRules: [
    {
      id: 1,
      merchantPattern: 'OLD-STORE',
      matchKind: 'substring',
      category: 'Groceries',
      priority: 0,
      createdAt: '2025-01-01T00:00:00Z',
      lastMatchedAt: '2025-12-01',
      matchCount: 5,
    },
    {
      id: 2,
      merchantPattern: 'NEVER-USED',
      matchKind: 'substring',
      category: null,
      priority: 0,
      createdAt: '2026-01-01T00:00:00Z',
      lastMatchedAt: null,
      matchCount: 0,
    },
  ],
  duplicateRules: [
    {
      merchantPattern: 'duplicate-pattern',
      matchKind: 'substring',
      ruleIds: [10, 11],
    },
  ],
  topMerchantsWithoutRules: [
    { merchantCanonical: 'Coffee Shop', count: 9 },
    { merchantCanonical: 'Random Store', count: 4 },
  ],
}

const SUGGESTIONS = {
  suggestions: [
    {
      merchantPattern: 'STARBUCKS COFFEE',
      category: 'Dining',
      isBusiness: false,
      splitType: 'me',
      pctMe: null,
      pctPartner: null,
      supportCount: 8,
      exampleTransactionIds: [101, 102],
    },
  ],
}

function mockFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo) => {
      const url = String(input)
      if (url.endsWith('/api/rules/health'))
        return Promise.resolve({ ok: true, json: () => Promise.resolve(HEALTH) } as Response)
      if (url.endsWith('/api/rules/suggestions'))
        return Promise.resolve({ ok: true, json: () => Promise.resolve(SUGGESTIONS) } as Response)
      if (url.includes('/api/ai/rule-proposals/') && url.endsWith('/approve'))
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ id: 99 }),
        } as Response)
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) } as Response)
    }),
  )
}

describe('RulesHealthSection', () => {
  beforeEach(() => {
    mockFetch()
  })

  it('renders the headline hit-rate metric and uncategorized/review counts', async () => {
    render(<RulesHealthSection onAfterCreate={vi.fn()} />)
    await waitFor(() => expect(screen.getByText('75%')).toBeInTheDocument())
    expect(screen.getByText('8')).toBeInTheDocument()
    expect(screen.getByText('3')).toBeInTheDocument()
  })

  it('lists stale rules including the never-used one', async () => {
    render(<RulesHealthSection onAfterCreate={vi.fn()} />)
    await waitFor(() => expect(screen.getByText('OLD-STORE')).toBeInTheDocument())
    expect(screen.getByText('NEVER-USED')).toBeInTheDocument()
    expect(screen.getByText('Never')).toBeInTheDocument()
  })

  it('lists duplicate rule groups', async () => {
    render(<RulesHealthSection onAfterCreate={vi.fn()} />)
    await waitFor(() => expect(screen.getByText(/duplicate-pattern/)).toBeInTheDocument())
    expect(screen.getByText(/#10, #11/)).toBeInTheDocument()
  })

  it('lists top merchants without a matching rule', async () => {
    render(<RulesHealthSection onAfterCreate={vi.fn()} />)
    await waitFor(() => expect(screen.getByText('Coffee Shop')).toBeInTheDocument())
    expect(screen.getByText('Random Store')).toBeInTheDocument()
  })

  it('renders suggestions and lets the user create a rule from one', async () => {
    const onAfterCreate = vi.fn()
    render(<RulesHealthSection onAfterCreate={onAfterCreate} />)

    await waitFor(() =>
      expect(screen.getByText('STARBUCKS COFFEE')).toBeInTheDocument(),
    )
    const button = screen.getByRole('button', { name: /Create rule/ })
    button.click()
    await waitFor(() => expect(onAfterCreate).toHaveBeenCalled())
  })
})
