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

  it('routes a date-suffixed Wealthsimple monthly export to ws-bundle', () => {
    // WS moved the date to the end of the name in 2026-08:
    // <name>-monthly-statement-transactions-<WSID>-<YYYY-MM-DD>.csv
    // This case was previously asserted to be an RBC export and forced to
    // 'standard'. It is not — WK3DD9X35CAD is a WS account id, and RBC issues
    // no such token. Field ORDER never identified the institution; the WSID does.
    expect(
      detectMode([csv('Chequing-monthly-statement-transactions-WK3DD9X35CAD-2026-01-01.csv')]),
    ).toBe('ws-bundle')
    expect(
      detectMode([
        csv('Corporate chequing-monthly-statement-transactions-WK79NVW07CAD-2026-08-01.csv'),
      ]),
    ).toBe('ws-bundle')
  })

  it('routes a genuine bank statement CSV to standard, NOT ws-bundle (bank files must not hit the WS importer)', () => {
    // A real RBC export carries no WS account id, in any field position.
    expect(
      detectMode([csv('Chequing-monthly-statement-transactions-2026-01-01.csv')]),
    ).toBe('standard')
    expect(detectMode([csv('rbc-chequing-6985-2026-01.csv')])).toBe('standard')
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

  /**
   * The submit handler set the feedback banner and then called reset(), which
   * clears it. React batches both updates into one render, so last-write-wins
   * left feedback null and the user saw a successful import render nothing at
   * all. The old test above mocked `{ results: [] }` and asserted only that the
   * fetch happened, so it stayed green throughout.
   */
  async function submitWsBundle(results: unknown[]) {
    vi.spyOn(api, 'getJson').mockResolvedValue([] as never)
    vi.spyOn(api, 'postFormData').mockResolvedValue({ results } as never)

    render(
      <MemoryRouter>
        <ImportModal open onOpenChange={() => {}} accounts={[]} onCommitted={() => {}} />
      </MemoryRouter>,
    )

    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement
    const file = new File(
      ['date,transaction,description,amount,balance,currency\n'],
      'Chequing-monthly-statement-transactions-WK3DD9X35CAD-2026-08-01.csv',
      { type: 'text/csv' },
    )
    Object.defineProperty(fileInput, 'files', { value: [file], configurable: true })
    fireEvent.change(fileInput)

    fireEvent.click(await screen.findByRole('button', { name: /^import 1$/i }))
  }

  it('shows the result banner after a successful bundle import', async () => {
    await submitWsBundle([
      {
        file: 'Chequing-monthly-statement-transactions-WK3DD9X35CAD-2026-08-01.csv',
        accountName: 'Wealthsimple Chequing',
        accountCreated: false,
        inserted: 15,
        skippedDuplicates: 0,
        rowErrors: 0,
        parseErrors: [],
        warnings: [],
      },
    ])

    expect(await screen.findByText(/1\/1 imported/)).toBeInTheDocument()
    // The per-file line, not the headline count — both mention the row total.
    expect(
      screen.getByText('Wealthsimple Chequing: 15 row(s)'),
    ).toBeInTheDocument()
  })

  it('names the account each file landed in, not just the filename', async () => {
    await submitWsBundle([
      {
        file: 'Corporate chequing-monthly-statement-transactions-WK79NVW07CAD-2026-08-01.csv',
        accountName: 'Wealthsimple Corporate Chequing',
        accountCreated: false,
        inserted: 4,
        skippedDuplicates: 0,
        rowErrors: 0,
        parseErrors: [],
        warnings: [],
      },
    ])

    expect(await screen.findByText(/Wealthsimple Corporate Chequing/)).toBeInTheDocument()
  })

  it('reports duplicates skipped on a re-import instead of a bare 0 rows', async () => {
    // Re-importing the same statement inserts nothing and skips every row as a
    // duplicate. `skippedDuplicates` is the field the backend actually sends;
    // the UI previously read a `skipped` flag that no endpoint ever returns, so
    // this case was indistinguishable from a silent no-op.
    await submitWsBundle([
      {
        file: 'Chequing-monthly-statement-transactions-WK3DD9X35CAD-2026-08-01.csv',
        accountName: 'Wealthsimple Chequing',
        accountCreated: false,
        inserted: 0,
        skippedDuplicates: 15,
        rowErrors: 0,
        parseErrors: [],
        warnings: [],
      },
    ])

    expect(await screen.findByText(/15 duplicate/)).toBeInTheDocument()
  })

  it('surfaces a per-file error and flags the batch as not fully imported', async () => {
    await submitWsBundle([
      {
        file: 'Chequing-monthly-statement-transactions-WK3DD9X35CAD-2026-08-01.csv',
        accountName: 'Wealthsimple Chequing',
        accountCreated: false,
        inserted: 12,
        skippedDuplicates: 0,
        rowErrors: 0,
        parseErrors: [],
        warnings: [],
      },
      {
        file: 'Corporate chequing-monthly-statement-transactions-WK79NVW07CAD-2026-08-01.csv',
        accountName: null,
        accountCreated: false,
        inserted: 0,
        skippedDuplicates: 0,
        rowErrors: 0,
        parseErrors: [],
        warnings: [],
        error: 'unrecognized Wealthsimple filename',
      },
    ])

    expect(await screen.findByText(/1\/2 imported/)).toBeInTheDocument()
    expect(screen.getByText(/unrecognized Wealthsimple filename/)).toBeInTheDocument()
  })

  it('clears the staged file list even though the banner stays', async () => {
    await submitWsBundle([
      {
        file: 'Chequing-monthly-statement-transactions-WK3DD9X35CAD-2026-08-01.csv',
        accountName: 'Wealthsimple Chequing',
        accountCreated: false,
        inserted: 15,
        skippedDuplicates: 0,
        rowErrors: 0,
        parseErrors: [],
        warnings: [],
      },
    ])

    // Banner visible…
    expect(await screen.findByText(/1\/1 imported/)).toBeInTheDocument()
    // …and the drop-zone is ready for the next drop: the submit button falls
    // back to its empty-state label rather than still offering "Import 1".
    expect(screen.queryByRole('button', { name: /^import 1$/i })).not.toBeInTheDocument()
  })
})
