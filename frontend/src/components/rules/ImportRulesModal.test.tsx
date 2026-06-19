import React from 'react'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ImportRulesModal } from './ImportRulesModal'
import { ToastProvider } from '@/components/ui/toast'

/**
 * Component tests for the ImportRulesModal (issue #438). Covers the
 * client-side behaviour the issue's test plan calls out: file-size guard,
 * schema validation, preview count, the Replace confirmation dialog, and the
 * success toast on a completed import.
 */

const VALID_EXPORT = {
  schemaVersion: 1,
  exportedAt: '2026-06-19T00:00:00.000Z',
  rules: [
    { merchantPattern: 'NETFLIX', matchKind: 'substring', priority: 0, category: 'Subscriptions', isBusiness: false, splitType: 'me', pctMe: null, pctPartner: null, effectiveFrom: null, effectiveTo: null },
    { merchantPattern: 'UBER', matchKind: 'substring', priority: 0, category: 'Transport', isBusiness: false, splitType: 'me', pctMe: null, pctPartner: null, effectiveFrom: null, effectiveTo: null },
  ],
}

function makeFile(content: string, { size }: { size?: number } = {}) {
  const file = new File([content], 'rules.json', { type: 'application/json' })
  if (size != null) {
    Object.defineProperty(file, 'size', { value: size })
  }
  return file
}

function getFileInput(): HTMLInputElement {
  const input = document.querySelector('input[type="file"]')
  if (!input) throw new Error('file input not found')
  return input as HTMLInputElement
}

function renderModal(props: Partial<React.ComponentProps<typeof ImportRulesModal>> = {}) {
  const onOpenChange = vi.fn()
  const onSuccess = vi.fn()
  render(
    <ToastProvider>
      <ImportRulesModal
        open
        onOpenChange={onOpenChange}
        currentRuleCount={props.currentRuleCount ?? 0}
        onSuccess={onSuccess}
      />
    </ToastProvider>,
  )
  return { onOpenChange, onSuccess }
}

describe('ImportRulesModal', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  // AC #6 — modal shows a preview of the rule count from the parsed file.
  it('parses a valid file and shows the rule count preview', async () => {
    renderModal()
    const input = getFileInput()
    await userEvent.upload(input, makeFile(JSON.stringify(VALID_EXPORT)))
    expect(await screen.findByText(/Found 2 rules in this file\./i)).toBeInTheDocument()
  })

  // AC #10 — files > 1 MB rejected client-side, no parse attempt.
  it('rejects a file larger than 1 MB without parsing', async () => {
    renderModal()
    const input = getFileInput()
    await userEvent.upload(input, makeFile('{}', { size: 1_000_001 }))
    expect(await screen.findByText(/File too large\./i)).toBeInTheDocument()
    expect(screen.queryByText(/Found .* rules in this file/i)).toBeNull()
  })

  // AC #8 — wrong/newer schemaVersion surfaces the right error, no preview.
  it('shows the bad-file error for a non-export JSON', async () => {
    renderModal()
    const input = getFileInput()
    await userEvent.upload(input, makeFile(JSON.stringify({ foo: 'bar' })))
    expect(
      await screen.findByText(/This file isn't a valid Cashflow rules export\./i),
    ).toBeInTheDocument()
  })

  it('shows the newer-version error for a future schemaVersion', async () => {
    renderModal()
    const input = getFileInput()
    await userEvent.upload(input, makeFile(JSON.stringify({ ...VALID_EXPORT, schemaVersion: 2 })))
    expect(
      await screen.findByText(/This file is from a newer version of Cashflow\. Update and try again\./i),
    ).toBeInTheDocument()
  })

  // AC #7 — choosing Replace triggers the confirm dialog with the exact copy.
  it('shows the Replace confirmation dialog with exact copy when replacing existing rules', async () => {
    renderModal({ currentRuleCount: 3 })
    const input = getFileInput()
    await userEvent.upload(input, makeFile(JSON.stringify(VALID_EXPORT)))
    await screen.findByText(/Found 2 rules in this file\./i)

    await userEvent.click(screen.getByRole('radio', { name: /replace/i }))
    await userEvent.click(screen.getByRole('button', { name: /^import$/i }))

    const confirmTitle = await screen.findByText('Replace all rules?')
    expect(confirmTitle).toBeInTheDocument()
    // Scope the body + button assertions to the confirm dialog so we don't
    // collide with the import modal's own Cancel button.
    const confirmDialog = confirmTitle.closest('[data-slot="dialog"]') as HTMLElement
    expect(confirmDialog).toBeTruthy()
    const dialog = within(confirmDialog)
    expect(
      dialog.getByText('This deletes 3 rule(s) and imports 2 from the file. This cannot be undone.'),
    ).toBeInTheDocument()
    // The destructive confirm + cancel buttons carry the exact labels.
    expect(dialog.getByRole('button', { name: 'Replace' })).toBeInTheDocument()
    expect(dialog.getByRole('button', { name: 'Cancel' })).toBeInTheDocument()
  })

  // AC #11 — successful import fires the toast and calls onSuccess.
  it('imports and fires the success toast', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        json: () => Promise.resolve({ imported: 2, skipped: 0, errors: [] }),
      } as unknown as Response),
    )
    vi.stubGlobal('fetch', fetchMock)

    const { onSuccess } = renderModal({ currentRuleCount: 0 })
    const input = getFileInput()
    await userEvent.upload(input, makeFile(JSON.stringify(VALID_EXPORT)))
    await screen.findByText(/Found 2 rules in this file\./i)

    // Append mode (default, currentRuleCount 0) → no confirm dialog.
    await userEvent.click(screen.getByRole('button', { name: /^import$/i }))

    await waitFor(() => expect(onSuccess).toHaveBeenCalled())
    // The import endpoint was hit with append mode + the parsed payload.
    const call = fetchMock.mock.calls.find((c) => String(c[0]).endsWith('/api/rules/import'))
    expect(call).toBeTruthy()
    const body = JSON.parse(String((call![1] as RequestInit).body))
    expect(body.mode).toBe('append')
    expect(body.json.rules).toHaveLength(2)

    // Success toast surfaces the imported count.
    expect(await screen.findByText(/Imported 2 rules\./i)).toBeInTheDocument()
  })

  it('surfaces skipped count in the toast when some rules failed', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        json: () => Promise.resolve({ imported: 1, skipped: 1, errors: [{ name: 'X', reason: 'bad' }] }),
      } as unknown as Response),
    )
    vi.stubGlobal('fetch', fetchMock)

    renderModal({ currentRuleCount: 0 })
    const input = getFileInput()
    await userEvent.upload(input, makeFile(JSON.stringify(VALID_EXPORT)))
    await screen.findByText(/Found 2 rules in this file\./i)
    await userEvent.click(screen.getByRole('button', { name: /^import$/i }))

    expect(
      await screen.findByText(/Imported 1 rules\. Skipped 1 rule\(s\) \(see details\)/i),
    ).toBeInTheDocument()
  })

  it('keeps the Import button disabled until a valid file is parsed', async () => {
    renderModal()
    const importBtn = screen.getByRole('button', { name: /^import$/i })
    expect(importBtn).toBeDisabled()
    const input = getFileInput()
    await userEvent.upload(input, makeFile(JSON.stringify(VALID_EXPORT)))
    await screen.findByText(/Found 2 rules in this file\./i)
    expect(importBtn).toBeEnabled()
  })
})
