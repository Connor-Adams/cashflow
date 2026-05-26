import React from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { RulesPage } from './RulesPage'
import { ToastProvider } from '@/components/ui/toast'

const SAMPLE_RULES = [
  { id: 1, merchantPattern: 'amazon', matchKind: 'substring', priority: 0, category: 'Shopping', isBusiness: false, splitType: 'me', pctMe: null, pctPartner: null, usageCount: 1204 },
  { id: 2, merchantPattern: 'uber', matchKind: 'substring', priority: 0, category: 'Transport', isBusiness: false, splitType: 'me', pctMe: null, pctPartner: null, usageCount: 312 },
]

function mockFetch(rules: typeof SAMPLE_RULES) {
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo) => {
    const url = String(input)
    if (url.endsWith('/api/rules')) return Promise.resolve({ ok: true, json: () => Promise.resolve(rules) } as Response)
    if (url.endsWith('/api/rules/auto-suggestions')) return Promise.resolve({ ok: true, json: () => Promise.resolve({ suggestions: [] }) } as Response)
    if (url.endsWith('/api/transactions/category-hints')) return Promise.resolve({ ok: true, json: () => Promise.resolve({ categories: [] }) } as Response)
    return Promise.resolve({ ok: true, json: () => Promise.resolve({}) } as Response)
  }))
}

const SAMPLE_SUGGESTION = {
  id: 'abc123def456',
  merchantPattern: 'METRO',
  category: 'Groceries',
  isBusiness: false,
  splitType: 'me',
  pctMe: null,
  pctPartner: null,
  supportCount: 5,
  exampleTransactionIds: [101, 102, 103, 104, 105],
  confidence: 'high' as const,
  reasoning:
    'You categorized 5 reviewed transactions for "METRO" as "Groceries" with no exceptions.',
  evidence: [
    {
      id: 101,
      date: '2026-04-01',
      merchantClean: 'METRO',
      amount: '-12.50',
      currency: 'CAD',
      finalCategory: 'Groceries',
      finalBusiness: false,
      finalSplitType: 'me',
    },
  ],
}

function mockFetchWithSuggestions(
  rules: typeof SAMPLE_RULES,
  suggestions: typeof SAMPLE_SUGGESTION[],
) {
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo) => {
    const url = String(input)
    if (url.endsWith('/api/rules')) return Promise.resolve({ ok: true, json: () => Promise.resolve(rules) } as Response)
    if (url.endsWith('/api/rules/auto-suggestions')) return Promise.resolve({ ok: true, json: () => Promise.resolve({ suggestions }) } as Response)
    if (url.endsWith('/api/transactions/category-hints')) return Promise.resolve({ ok: true, json: () => Promise.resolve({ categories: [] }) } as Response)
    return Promise.resolve({ ok: true, json: () => Promise.resolve({}) } as Response)
  }))
}

describe('RulesPage', () => {
  beforeEach(() => {
    mockFetch(SAMPLE_RULES)
    Element.prototype.scrollIntoView = vi.fn()
  })

  describe('?focus query param', () => {
    it('applies isFocused class to the row whose id matches focus', async () => {
      render(
        <MemoryRouter initialEntries={['/rules?focus=2']}>
          <ToastProvider>
            <RulesPage />
          </ToastProvider>
        </MemoryRouter>,
      )
      await waitFor(() => expect(screen.getByText('uber')).toBeInTheDocument())
      const row = screen.getByText('uber').closest('tr')!
      expect(row.className).toContain('isFocused')
    })

    it('calls scrollIntoView on the focused row', async () => {
      render(
        <MemoryRouter initialEntries={['/rules?focus=2']}>
          <ToastProvider>
            <RulesPage />
          </ToastProvider>
        </MemoryRouter>,
      )
      await waitFor(() => expect(screen.getByText('uber')).toBeInTheDocument())
      await waitFor(() =>
        expect(Element.prototype.scrollIntoView).toHaveBeenCalled(),
      )
    })

    it('does not error when focus is missing', async () => {
      render(
        <MemoryRouter initialEntries={['/rules']}>
          <ToastProvider>
            <RulesPage />
          </ToastProvider>
        </MemoryRouter>,
      )
      await waitFor(() => expect(screen.getByText('amazon')).toBeInTheDocument())
      const row = screen.getByText('amazon').closest('tr')!
      expect(row.className).not.toContain('isFocused')
    })
  })

  describe('auto-suggestions section', () => {
    it('renders confidence chip + reasoning + accept and dismiss buttons', async () => {
      mockFetchWithSuggestions(SAMPLE_RULES, [SAMPLE_SUGGESTION])
      render(
        <MemoryRouter initialEntries={['/rules']}>
          <ToastProvider>
            <RulesPage />
          </ToastProvider>
        </MemoryRouter>,
      )
      await waitFor(() => expect(screen.getByText('METRO')).toBeInTheDocument())
      expect(screen.getByText(/high confidence/i)).toBeInTheDocument()
      expect(screen.getByText(SAMPLE_SUGGESTION.reasoning)).toBeInTheDocument()
      expect(screen.getByRole('button', { name: /accept/i })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: /dismiss/i })).toBeInTheDocument()
      expect(
        screen.getByRole('button', { name: /show evidence/i }),
      ).toBeInTheDocument()
    })

    it('omits the section when there are no suggestions', async () => {
      mockFetchWithSuggestions(SAMPLE_RULES, [])
      render(
        <MemoryRouter initialEntries={['/rules']}>
          <ToastProvider>
            <RulesPage />
          </ToastProvider>
        </MemoryRouter>,
      )
      await waitFor(() => expect(screen.getByText('amazon')).toBeInTheDocument())
      expect(screen.queryByText(/auto-suggested rules/i)).not.toBeInTheDocument()
    })
  })
})
