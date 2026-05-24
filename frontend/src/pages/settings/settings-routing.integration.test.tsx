import React from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes, Navigate } from 'react-router-dom'
import { describe, it, expect, vi } from 'vitest'
import { SettingsPage } from './SettingsPage'
import { SettingsTabLayout } from './SettingsTabLayout'
import { DisplaySection } from './sections/DisplaySection'
import { GmailSection } from './sections/GmailSection'
import { PartnerInviteSection } from './sections/PartnerInviteSection'
import { ImportsTab } from './tabs/ImportsTab'
import { EnrichmentTab } from './tabs/EnrichmentTab'
import { ContactsTab } from './tabs/ContactsTab'
import { BudgetsTab } from './tabs/BudgetsTab'

vi.mock('../../lib/useAuth', () => ({
  useAuth: () => ({
    user: { household: { name: 'Test HH' }, email: 't@x.io', globalRole: null },
  }),
}))

vi.mock('@/lib/layoutWidth', () => ({
  useLayoutWidth: () => ['standard', () => {}] as const,
  layoutWidthOptions: [
    { value: 'standard', label: 'Standard', description: '' },
    { value: 'wide', label: 'Wide', description: '' },
    { value: 'ultrawide', label: 'Ultrawide', description: '' },
  ],
}))

vi.stubGlobal(
  'fetch',
  vi.fn((input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString()
    const body = url.includes('/api/contacts') ? [] : {}
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve(body),
    } as Response)
  }),
)

function renderApp(initialPath: string) {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Routes>
        <Route path="/settings" element={<SettingsPage />}>
          <Route index element={<Navigate to="display" replace />} />
          <Route element={<SettingsTabLayout />}>
            <Route path="display" element={<DisplaySection />} />
            <Route path="gmail" element={<GmailSection />} />
            <Route path="partner-invite" element={<PartnerInviteSection />} />
          </Route>
          <Route path="imports" element={<ImportsTab />} />
          <Route path="enrichment" element={<EnrichmentTab />} />
          <Route path="contacts" element={<ContactsTab />} />
          <Route path="budgets" element={<BudgetsTab />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  )
}

describe('settings routing', () => {
  it('/settings redirects to /settings/display', () => {
    renderApp('/settings')
    expect(screen.getByRole('heading', { name: /display width/i })).toBeInTheDocument()
  })

  it('clicking the Contacts top tab navigates to contacts', async () => {
    renderApp('/settings/display')
    await userEvent.click(screen.getByRole('tab', { name: 'Contacts' }))
    expect(screen.getByRole('heading', { name: /contacts ledger/i })).toBeInTheDocument()
  })

  it('clicking the Gmail sidebar link inside Settings tab swaps section', async () => {
    renderApp('/settings/display')
    await userEvent.click(screen.getByRole('link', { name: 'Gmail' }))
    expect(screen.getByRole('heading', { name: /connect gmail/i })).toBeInTheDocument()
  })

  it('left sidebar disappears outside Settings tab', () => {
    renderApp('/settings/contacts')
    expect(screen.queryByRole('link', { name: 'Display' })).not.toBeInTheDocument()
  })
})
