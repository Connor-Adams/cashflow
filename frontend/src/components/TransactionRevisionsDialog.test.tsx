import React from 'react'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { TransactionRevisionsDialog } from './TransactionRevisionsDialog'

/**
 * Component test for the issue #229 transaction history viewer + restore.
 *
 * Mocks fetch with a sequence of responses so we can drive:
 *   1. initial GET /api/transactions/:id/revisions
 *   2. POST /api/transactions/:id/revisions/:rid/restore (when Restore clicked)
 *   3. follow-up GET to refresh the timeline after restore
 */

function queueFetch(responses: Array<{ status: number; body: unknown }>) {
  let i = 0
  return vi.fn(() => {
    const r = responses[i] ?? responses[responses.length - 1]
    i += 1
    return Promise.resolve({
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      json: () => Promise.resolve(r.body),
    } as Response)
  })
}

describe('TransactionRevisionsDialog', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('renders the empty-state when a transaction has no revisions', async () => {
    vi.stubGlobal('fetch', queueFetch([{ status: 200, body: { data: [] } }]))
    render(
      <TransactionRevisionsDialog transactionId={42} onClose={() => {}} />,
    )
    await waitFor(() => {
      expect(
        screen.getByText(/no edits recorded for this transaction yet/i),
      ).toBeTruthy()
    })
  })

  it('renders one entry per revision with the field diff and source badge', async () => {
    vi.stubGlobal(
      'fetch',
      queueFetch([
        {
          status: 200,
          body: {
            data: [
              {
                id: 7,
                transactionId: 42,
                source: 'user_edit',
                changedByUserId: 9,
                aiSuggestionId: null,
                changes: [
                  { field: 'categoryOverride', before: null, after: 'Groceries' },
                ],
                createdAt: '2026-05-26T12:00:00Z',
              },
              {
                id: 8,
                transactionId: 42,
                source: 'ai_suggestion',
                changedByUserId: 9,
                aiSuggestionId: 333,
                changes: [
                  { field: 'notes', before: null, after: 'On sale' },
                ],
                createdAt: '2026-05-26T12:05:00Z',
              },
            ],
          },
        },
      ]),
    )
    render(
      <TransactionRevisionsDialog transactionId={42} onClose={() => {}} />,
    )
    await waitFor(() => {
      // Field diff appears for each entry.
      expect(screen.getAllByText(/categoryOverride/i).length).toBeGreaterThan(0)
      expect(screen.getAllByText(/notes/i).length).toBeGreaterThan(0)
    })
    // Source label rendering.
    expect(screen.getByText(/edited/i)).toBeTruthy()
    expect(screen.getByText(/AI accepted/i)).toBeTruthy()
    // AI suggestion id surfaces in the metadata line.
    expect(screen.getByText(/AI suggestion #333/i)).toBeTruthy()
  })

  it('calls the restore endpoint and notifies the parent on success', async () => {
    const onRestored = vi.fn()
    vi.stubGlobal(
      'fetch',
      queueFetch([
        // Initial GET
        {
          status: 200,
          body: {
            data: [
              {
                id: 5,
                transactionId: 99,
                source: 'user_edit',
                changedByUserId: 1,
                aiSuggestionId: null,
                changes: [
                  { field: 'categoryOverride', before: 'OldCat', after: 'NewCat' },
                ],
                createdAt: '2026-05-26T12:00:00Z',
              },
            ],
          },
        },
        // POST restore
        {
          status: 200,
          body: {
            transaction: { id: 99, categoryOverride: 'OldCat' },
            restored: [{ field: 'categoryOverride', restoredTo: 'OldCat' }],
          },
        },
        // Follow-up GET after restore
        {
          status: 200,
          body: {
            data: [
              {
                id: 5,
                transactionId: 99,
                source: 'user_edit',
                changedByUserId: 1,
                aiSuggestionId: null,
                changes: [
                  { field: 'categoryOverride', before: 'OldCat', after: 'NewCat' },
                ],
                createdAt: '2026-05-26T12:00:00Z',
              },
              {
                id: 6,
                transactionId: 99,
                source: 'restore',
                changedByUserId: 1,
                aiSuggestionId: null,
                changes: [
                  { field: 'categoryOverride', before: 'NewCat', after: 'OldCat' },
                ],
                createdAt: '2026-05-26T12:01:00Z',
              },
            ],
          },
        },
      ]),
    )
    render(
      <TransactionRevisionsDialog
        transactionId={99}
        onClose={() => {}}
        onRestored={onRestored}
      />,
    )
    const restoreBtn = await waitFor(() => screen.getByRole('button', { name: /restore/i }))
    fireEvent.click(restoreBtn)
    await waitFor(() => {
      expect(onRestored).toHaveBeenCalledWith({ id: 99, categoryOverride: 'OldCat' })
    })
    // Status message after restore.
    await waitFor(() => {
      expect(screen.getByText(/restored 1 field/i)).toBeTruthy()
    })
  })

  it('does not render a restore button when no fields are restorable', async () => {
    vi.stubGlobal(
      'fetch',
      queueFetch([
        {
          status: 200,
          body: {
            data: [
              {
                id: 1,
                transactionId: 7,
                source: 'enrichment',
                changedByUserId: null,
                aiSuggestionId: null,
                changes: [
                  // autoSource is REVISIONED but NOT restorable.
                  { field: 'autoSource', before: null, after: 'rule' },
                ],
                createdAt: '2026-05-26T12:00:00Z',
              },
            ],
          },
        },
      ]),
    )
    render(
      <TransactionRevisionsDialog transactionId={7} onClose={() => {}} />,
    )
    await waitFor(() => {
      expect(screen.getAllByText(/autoSource/i).length).toBeGreaterThan(0)
    })
    expect(screen.queryByRole('button', { name: /restore/i })).toBeNull()
  })
})
