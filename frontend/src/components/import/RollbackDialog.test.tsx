import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { RollbackDialog, type RollbackImpact } from './RollbackDialog'
import * as api from '@/lib/api'

function cleanImpact(overrides: Partial<RollbackImpact> = {}): RollbackImpact {
  return {
    batchLabel: 'preview-batch-1',
    importHistoryId: 12,
    canRollback: true,
    blockers: [],
    transactionCount: 2,
    dependentCounts: {
      receipts: 0,
      aiSuggestions: 0,
      transactionSignals: 0,
      transactionTaxMetadata: 0,
      budgetExclusions: 0,
      plannedEventsUnlinked: 0,
      investmentActivities: 0,
      holdingSnapshots: 0,
    },
    sample: [
      {
        id: 101,
        date: '2025-06-01',
        merchantClean: 'Preview Cafe',
        amount: '-5.50',
        currency: 'CAD',
      },
      {
        id: 102,
        date: '2025-06-02',
        merchantClean: 'Preview Shop',
        amount: '-3.00',
        currency: 'CAD',
      },
    ],
    ...overrides,
  }
}

describe('RollbackDialog', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('fetches preview and shows affected counts when open (AC: preview)', async () => {
    const getJson = vi.spyOn(api, 'getJson').mockResolvedValue(cleanImpact())
    render(
      <RollbackDialog
        open
        batchLabel="preview-batch-1"
        onClose={() => {}}
        onRolledBack={() => {}}
      />,
    )
    await waitFor(() => {
      expect(getJson).toHaveBeenCalledWith(
        '/api/import/history/preview-batch-1/rollback-preview',
      )
    })
    expect(
      await screen.findByText('Transactions to delete'),
    ).toBeInTheDocument()
    expect(screen.getByTestId('rollback-counts')).toHaveTextContent('2')
    expect(screen.getByTestId('rollback-sample')).toHaveTextContent(
      'Preview Cafe',
    )
  })

  it('renders blockers and disables the rollback button (AC: blocked rollback)', async () => {
    vi.spyOn(api, 'getJson').mockResolvedValue(
      cleanImpact({
        canRollback: false,
        blockers: [
          {
            code: 'cross_batch_link',
            message: '2 transactions are linked to transfers in other batches.',
            count: 2,
          },
        ],
      }),
    )
    render(
      <RollbackDialog
        open
        batchLabel="preview-batch-1"
        onClose={() => {}}
        onRolledBack={() => {}}
      />,
    )
    const blockers = await screen.findByTestId('rollback-blockers')
    expect(blockers).toHaveTextContent('Cross-batch link')
    expect(blockers).toHaveTextContent('linked to transfers')
    const submit = screen.getByRole('button', { name: /roll back batch/i })
    expect(submit).toBeDisabled()
  })

  it('POSTs rollback and fires onRolledBack with the result (AC: rollback)', async () => {
    vi.spyOn(api, 'getJson').mockResolvedValue(cleanImpact())
    const postJson = vi.spyOn(api, 'postJson').mockResolvedValue({
      batchLabel: 'preview-batch-1',
      deletedTransactions: 2,
      deletedReceipts: 0,
      deletedAiSuggestions: 0,
      deletedTransactionSignals: 0,
      deletedTransactionTaxMetadata: 0,
      deletedBudgetExclusions: 0,
      unlinkedPlannedEvents: 0,
      deletedInvestmentActivities: 0,
      deletedHoldingSnapshots: 0,
    } as never)
    const onRolledBack = vi.fn()
    const onClose = vi.fn()
    render(
      <RollbackDialog
        open
        batchLabel="preview-batch-1"
        onClose={onClose}
        onRolledBack={onRolledBack}
      />,
    )
    await screen.findByText('Transactions to delete')
    const submit = screen.getByRole('button', { name: /roll back batch/i })
    await userEvent.click(submit)
    await waitFor(() => {
      expect(postJson).toHaveBeenCalledWith(
        '/api/import/history/preview-batch-1/rollback',
      )
    })
    expect(onRolledBack).toHaveBeenCalledTimes(1)
    expect(onRolledBack.mock.calls[0][0]).toMatchObject({
      deletedTransactions: 2,
    })
    expect(onClose).toHaveBeenCalled()
  })
})
