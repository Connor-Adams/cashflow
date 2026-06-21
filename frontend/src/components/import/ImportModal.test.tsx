import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { ImportModal } from './ImportModal'
import { detectMode, singleImportFeedback } from './importUtils'
import * as api from '@/lib/api'

const csv = (name: string) => new File([''], name, { type: 'text/csv' })
const pdf = (name: string) => new File([''], name, { type: 'application/pdf' })

describe('detectMode', () => {
  it('routes a single genuine Wealthsimple monthly export to ws-bundle', () => {
    // Real WS bulk export: <name>-<YYYY-MM-DD>-monthly-statement-transactions-<WSID>.csv
    expect(
      detectMode([csv('Chequing-2026-01-01-monthly-statement-transactions-WK3DD9X35CAD.csv')]),
    ).toBe('ws-bundle')
  })

  it('routes a Wealthsimple credit-card export to ws-bundle', () => {
    expect(
      detectMode([
        csv('Wealthsimple-credit-card-2026-01-01-credit-card-statement-transactions-ca-credit-card-AB12CD34.csv'),
      ]),
    ).toBe('ws-bundle')
  })

  it('routes a single RBC statement CSV to standard, NOT ws-bundle (bank files must not hit the WS importer)', () => {
    // Same tokens, different field order — this is an RBC export, not a WS one.
    expect(
      detectMode([csv('Chequing-monthly-statement-transactions-WK3DD9X35CAD-2026-01-01.csv')]),
    ).toBe('standard')
  })

  it('routes a plain bank download CSV to standard', () => {
    expect(detectMode([csv('download-transactions.csv')])).toBe('standard')
  })

  it('routes multiple non-Wealthsimple CSVs to standard, not ws-bundle', () => {
    expect(
      detectMode([csv('jan-statement.csv'), csv('feb-statement.csv')]),
    ).toBe('standard')
  })

  it('still detects holdings and pdf bundles', () => {
    expect(detectMode([csv('my-positions.csv')])).toBe('holdings')
    expect(detectMode([pdf('rbc_2026_01.pdf'), pdf('rbc_2026_02.pdf')])).toBe('pdf-bundle')
  })
})

describe('singleImportFeedback', () => {
  it('flags a wrong-profile parse failure (0 inserted, all rows errored) as a loud error', () => {
    const fb = singleImportFeedback({ inserted: 0, rowErrors: 2064 } as never, 'generic_simple')
    expect(fb.variant).toBe('error')
    expect(fb.title).toMatch(/profile/i)
    expect(fb.title).toMatch(/0 of 2064/)
  })

  it('warns on a partial import (some rows errored)', () => {
    const fb = singleImportFeedback(
      { inserted: 10, rowErrors: 3, batchLabel: 'b' } as never,
      'rbc',
    )
    expect(fb.variant).toBe('warning')
  })

  it('reports success when rows import cleanly', () => {
    const fb = singleImportFeedback(
      { inserted: 42, rowErrors: 0, batchLabel: 'b', skippedDuplicates: 1 } as never,
      'rbc',
    )
    expect(fb.variant).toBe('success')
    expect(fb.title).toMatch(/42 row/)
  })

  it('treats a skipped (already-imported) file as a warning, not a failure', () => {
    const fb = singleImportFeedback(
      { skipped: true, reason: 'already_imported' } as never,
      'rbc',
    )
    expect(fb.variant).toBe('warning')
  })
})

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

    // A genuine Wealthsimple monthly-statement CSV auto-detects as the ws-bundle mode.
    // The file input is visually hidden, so set files directly then fire change.
    const fileInput = document.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement
    const file = new File(
      ['Date,Amount\n2026-01-02,-5.00\n'],
      'Chequing-2026-01-01-monthly-statement-transactions-WK3DD9X35CAD.csv',
      { type: 'text/csv' },
    )
    Object.defineProperty(fileInput, 'files', {
      value: [file],
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
