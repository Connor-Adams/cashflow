import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom'
import { ToastProvider } from '@/components/ui/toast'
import { ScopedTokensPanel, type PanelTokenScope } from './ScopedTokensPanel'
import * as api from '@/lib/api'

const ROW = { id: 7, label: 'CI agent', lastUsedAt: null, createdAt: new Date().toISOString() }

function renderPanel(scope: PanelTokenScope) {
  return render(
    <ToastProvider>
      <ScopedTokensPanel scope={scope} />
    </ToastProvider>,
  )
}

describe('ScopedTokensPanel', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it.each([
    ['audit', '/api/audit/tokens', 'AI audit tokens', 'cfa_'],
    ['reporting', '/api/v1/tokens', 'Reporting tokens', 'cfr_'],
  ] as const)('%s scope lists from %s with its own copy', async (scope, endpoint, title, prefix) => {
    const getJson = vi.spyOn(api, 'getJson').mockResolvedValue([ROW] as never)
    renderPanel(scope)
    expect(await screen.findByText(title)).toBeInTheDocument()
    expect(screen.getByText(prefix)).toBeInTheDocument()
    expect(screen.getByText('CI agent')).toBeInTheDocument()
    expect(getJson).toHaveBeenCalledWith(endpoint)
  })

  it('shows a scope-specific empty state', async () => {
    vi.spyOn(api, 'getJson').mockResolvedValue([] as never)
    renderPanel('reporting')
    expect(await screen.findByText('No active reporting tokens')).toBeInTheDocument()
  })

  it('mints against the scope endpoint with the scope default label and reveals the plaintext once', async () => {
    vi.spyOn(api, 'getJson').mockResolvedValue([] as never)
    const postJson = vi
      .spyOn(api, 'postJson')
      .mockResolvedValue({ id: 9, plaintext: 'cfa_' + 'x'.repeat(32), label: 'Audit', createdAt: '' } as never)
    renderPanel('audit')
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: 'Mint token' }))
    expect(postJson).toHaveBeenCalledWith('/api/audit/tokens', { label: 'Audit' })
    expect(await screen.findByLabelText('New audit token')).toHaveValue('cfa_' + 'x'.repeat(32))
    expect(screen.getByText('CASHFLOW_AUDIT_TOKEN')).toBeInTheDocument()
  })

  it('revokes via DELETE on the scope endpoint', async () => {
    vi.spyOn(api, 'getJson').mockResolvedValue([ROW] as never)
    const deleteReq = vi.spyOn(api, 'deleteReq').mockResolvedValue(undefined as never)
    renderPanel('reporting')
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: 'Revoke CI agent' }))
    await waitFor(() => expect(deleteReq).toHaveBeenCalledWith('/api/v1/tokens/7'))
  })
})
