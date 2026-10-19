import React from 'react'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { SyncPage } from './SyncPage'
import { postJson } from '../lib/api'

vi.mock('../lib/api', () => ({
  getJson: vi.fn(() => Promise.resolve({ data: [] })),
  postJson: vi.fn(() =>
    Promise.resolve({
      inserted: { transactions: 2 },
      skipped: {},
      sourceHouseholdId: 1,
      createdAt: '2026-10-01T00:00:00.000Z',
    }),
  ),
}))

describe('SyncPage restore (merge-only)', () => {
  beforeEach(() => {
    vi.mocked(postJson).mockClear()
  })

  it('offers no Replace option and no restore-mode picker', async () => {
    render(<SyncPage />)
    await screen.findByText('Restore from backup')
    expect(screen.queryByText(/replace/i)).toBeNull()
    expect(screen.queryByRole('radio')).toBeNull()
    expect(screen.getByRole('button', { name: 'Restore' })).toBeTruthy()
  })

  it('never sends mode=replace when restoring', async () => {
    const { container } = render(<SyncPage />)
    await screen.findByText('Restore from backup')

    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement
    const contents = '{"bundle":"QUJD","bundleVersion":1,"schemaVersion":1}'
    const file = new File([contents], 'b.cfbak.json', { type: 'application/json' })
    // jsdom's File has no .text(); the page reads the upload through it.
    Object.defineProperty(file, 'text', { value: () => Promise.resolve(contents) })
    fireEvent.change(fileInput, { target: { files: [file] } })
    await screen.findByText(/Selected: b\.cfbak\.json/)

    fireEvent.change(screen.getByPlaceholderText('Passphrase used at backup time'), {
      target: { value: 'a-long-passphrase' },
    })
    const restore = screen.getByRole('button', { name: 'Restore' })
    await waitFor(() => expect((restore as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(restore)

    await screen.findByText('Restore complete')
    const restoreCall = vi
      .mocked(postJson)
      .mock.calls.find(([url]) => url === '/api/sync/restore')
    expect(restoreCall).toBeTruthy()
    const body = restoreCall![1] as Record<string, unknown>
    expect(body.mode).not.toBe('replace')
    expect(body.bundle).toBe('QUJD')
  })
})
