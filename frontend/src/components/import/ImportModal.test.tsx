import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { ImportModal } from './ImportModal'
import * as api from '@/lib/api'

describe('ImportModal — Wealthsimple bundle', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('POSTs the WS bundle to the backend /api/import/upload-bundle route (AC: WS bundle import reaches the real endpoint)', async () => {
    // Profiles fetch fired on open — keep it quiet.
    vi.spyOn(api, 'getJson').mockResolvedValue([] as never)
    const postFormData = vi
      .spyOn(api, 'postFormData')
      .mockResolvedValue({ results: [] } as never)

    render(
      <MemoryRouter>
        <ImportModal
          open
          onOpenChange={() => {}}
          accounts={[]}
          onCommitted={() => {}}
        />
      </MemoryRouter>,
    )

    // A single Wealthsimple monthly-statement CSV auto-detects as the ws-bundle mode.
    // The file input is visually hidden, so set files directly then fire change.
    const fileInput = document.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement
    const csv = new File(
      ['Date,Amount\n2026-01-02,-5.00\n'],
      'Chequing-monthly-statement-transactions-WK3DD9X35CAD-2026-01-01.csv',
      { type: 'text/csv' },
    )
    Object.defineProperty(fileInput, 'files', {
      value: [csv],
      configurable: true,
    })
    fireEvent.change(fileInput)

    // Button enables and re-labels once a file is staged.
    const submit = await screen.findByRole('button', { name: /^import 1$/i })
    fireEvent.click(submit)

    await waitFor(() => {
      expect(postFormData).toHaveBeenCalledWith(
        '/api/import/upload-bundle',
        expect.any(FormData),
      )
    })
  })
})
