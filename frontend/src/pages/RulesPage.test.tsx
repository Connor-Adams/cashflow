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

type MockOverrides = {
  /**
   * Override the auto-suggestions endpoint body. Useful for asserting
   * defensive behaviour when the backend returns a malformed payload (e.g.
   * `{}` without a `suggestions` field).
   */
  autoSuggestionsBody?: unknown
}

function mockFetch(rules: typeof SAMPLE_RULES, overrides: MockOverrides = {}) {
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo) => {
    const url = String(input)
    if (url.endsWith('/api/rules')) return Promise.resolve({ ok: true, json: () => Promise.resolve(rules) } as Response)
    if (url.endsWith('/api/ai/rule-proposals')) return Promise.resolve({ ok: true, json: () => Promise.resolve({ proposals: [] }) } as Response)
    if (url.endsWith('/api/rules/auto-suggestions')) return Promise.resolve({
      ok: true,
      json: () =>
        Promise.resolve(
          overrides.autoSuggestionsBody !== undefined
            ? overrides.autoSuggestionsBody
            : { suggestions: [] },
        ),
    } as Response)
    if (url.endsWith('/api/rules/health')) return Promise.resolve({ ok: true, json: () => Promise.resolve({
      windowDays: 90,
      totalRules: rules.length,
      totalTransactions: 0,
      hitCount: 0,
      hitRate: 0,
      uncategorizedCount: 0,
      reviewFlagCount: 0,
      staleRules: [],
      duplicateRules: [],
      topMerchantsWithoutRules: [],
    }) } as Response)
    if (url.endsWith('/api/rules/suggestions')) return Promise.resolve({ ok: true, json: () => Promise.resolve({ suggestions: [] }) } as Response)
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

  describe('auto-suggestions resilience', () => {
    it('renders rules when /api/rules/auto-suggestions returns body without a suggestions field', async () => {
      // Regression: prior implementation read `r.suggestions` unconditionally
      // and then called `.length` on it, crashing the page when the backend
      // (or a test stub) returned `{}` instead of `{ suggestions: [] }`.
      mockFetch(SAMPLE_RULES, { autoSuggestionsBody: {} })
      render(
        <MemoryRouter initialEntries={['/rules']}>
          <ToastProvider>
            <RulesPage />
          </ToastProvider>
        </MemoryRouter>,
      )
      await waitFor(() => expect(screen.getByText('amazon')).toBeInTheDocument())
      // Sanity: the auto-suggestions section header should not appear when
      // there are no suggestions to surface.
      expect(screen.queryByText(/Auto-rule suggestions/i)).toBeNull()
    })
  })
})
