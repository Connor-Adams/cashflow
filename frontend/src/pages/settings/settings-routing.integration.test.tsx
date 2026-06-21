import React from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes, Navigate } from 'react-router-dom'
import { describe, it, expect, vi } from 'vitest'
import { SettingsPage } from './SettingsPage'
import { DisplaySection } from './sections/DisplaySection'
import { ContactsTab } from './tabs/ContactsTab'

vi.mock('../../lib/useAuth', () => ({
  useAuth: () => ({
    user: { household: { name: 'Test HH', role: 'owner' }, email: 't@x.io', globalRole: null },
  }),
}))

vi.stubGlobal(
  'fetch',
  vi.fn((input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString()
    const body = url.includes('/api/contacts') ? [] : {}
    return Promise.resolve({ ok: true, json: () => Promise.resolve(body) } as Response)
  }),
)

function renderApp(initialPath: string) {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Routes>
        <Route path="/settings" element={<SettingsPage />}>
          <Route index element={<Navigate to="display" replace />} />
          <Route path="display" element={<DisplaySection />} />
          <Route path="contacts" element={<ContactsTab />} />
          <Route path="appearance" element={<div>appearance-marker</div>} />
          <Route path="api-tokens" element={<div>api-tokens-marker</div>} />
          <Route path="palette" element={<Navigate to="/settings/appearance" replace />} />
          <Route path="design-system" element={<Navigate to="/settings/appearance" replace />} />
          <Route path="audit-tokens" element={<Navigate to="/settings/api-tokens" replace />} />
          <Route path="reporting-tokens" element={<Navigate to="/settings/api-tokens" replace />} />
          <Route path="budgets" element={<Navigate to="/budgets" replace />} />
          <Route path="enrichment" element={<Navigate to="/enrichment" replace />} />
        </Route>
        <Route path="/budgets" element={<div>budgets-page-marker</div>} />
        <Route path="/enrichment" element={<div>enrichment-page-marker</div>} />
      </Routes>
    </MemoryRouter>,
  )
}

describe('settings routing', () => {
  it('/settings redirects to /settings/display', () => {
    renderApp('/settings')
    expect(screen.getByRole('heading', { name: /display width/i })).toBeInTheDocument()
  })

  it('clicking a sidebar link navigates within settings', async () => {
    renderApp('/settings/display')
    await userEvent.click(screen.getByRole('link', { name: 'Contacts' }))
    expect(screen.getByRole('heading', { name: /contacts ledger/i })).toBeInTheDocument()
  })

  it.each([
    ['/settings/palette', 'appearance-marker'],
    ['/settings/design-system', 'appearance-marker'],
    ['/settings/audit-tokens', 'api-tokens-marker'],
    ['/settings/reporting-tokens', 'api-tokens-marker'],
  ])('%s redirects to its merged page', (path, marker) => {
    renderApp(path)
    expect(screen.getByText(marker)).toBeInTheDocument()
  })

  it.each([
    ['/settings/budgets', 'budgets-page-marker'],
    ['/settings/enrichment', 'enrichment-page-marker'],
  ])('%s redirects out of settings', (path, marker) => {
    renderApp(path)
    expect(screen.getByText(marker)).toBeInTheDocument()
  })
})
