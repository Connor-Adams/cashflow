import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MatchDividendModal } from './MatchDividendModal'
import * as api from '@/lib/api'
import type { DividendCandidate, DividendReconciliationRow } from '../../types/api'

void React

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return { ...actual, getJson: vi.fn(), postJson: vi.fn() }
})

const recon: DividendReconciliationRow = {
  reconciliationId: 1,
  securityDividendId: 10,
  accountId: 5,
  accountName: 'Brokerage',
  symbol: 'XYZ',
  securityName: 'XYZ Corp',
  exDividendDate: '2026-03-01',
  paymentDate: '2026-03-15',
  perShareAmount: '1.00',
  shares: '100',
  expectedAmount: 100,
  actualAmount: null,
  currency: 'USD',
  matchedTransactionId: null,
  matchedAt: null,
  matchSource: 'auto',
  variancePct: null,
  varianceFlag: false,
}

function candidate(over: Partial<DividendCandidate> = {}): DividendCandidate {
  return {
    id: 1,
    accountId: 5,
    amount: 100,
    date: '2026-03-15',
    merchant: 'XYZ DIVIDEND',
    currency: 'USD',
    score: 1000,
    warning: null,
    ...over,
  }
}

describe('MatchDividendModal', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders candidates in the order provided (AC #7 ranking)', () => {
    const candidates = [
      candidate({ id: 3, merchant: 'BEST', score: 1000 }),
      candidate({ id: 2, merchant: 'MID', score: 500 }),
      candidate({ id: 1, merchant: 'LOW', score: 100 }),
    ]
    render(
      <MatchDividendModal
        reconciliation={recon}
        onOpenChange={() => {}}
        onMatched={() => {}}
        onError={() => {}}
        initialCandidates={candidates}
      />,
    )
    const rows = screen.getAllByTestId('dividend-candidate')
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringContaining('BEST'),
      expect.stringContaining('MID'),
      expect.stringContaining('LOW'),
    ])
  })

  it('shows the wrong-tx warning when a debit is selected (AC #8)', () => {
    const candidates = [
      candidate({ id: 1, merchant: 'GOOD', amount: 100, warning: null }),
      candidate({ id: 2, merchant: 'A DEBIT', amount: -50, warning: 'debit' }),
    ]
    render(
      <MatchDividendModal
        reconciliation={recon}
        onOpenChange={() => {}}
        onMatched={() => {}}
        onError={() => {}}
        initialCandidates={candidates}
      />,
    )
    // No warning before selecting.
    expect(screen.queryByTestId('dividend-wrong-tx-warning')).not.toBeInTheDocument()
    // Select the debit row.
    fireEvent.click(screen.getByText('A DEBIT'))
    expect(screen.getByTestId('dividend-wrong-tx-warning')).toBeInTheDocument()
    expect(screen.getByTestId('dividend-wrong-tx-warning')).toHaveTextContent(
      /doesn't look like a dividend/i,
    )
  })

  it('still allows confirming a wrong-looking transaction (AC #8)', async () => {
    vi.mocked(api.postJson).mockResolvedValue({ ok: true })
    const onMatched = vi.fn()
    const candidates = [candidate({ id: 2, merchant: 'A DEBIT', amount: -50, warning: 'debit' })]
    render(
      <MatchDividendModal
        reconciliation={recon}
        onOpenChange={() => {}}
        onMatched={onMatched}
        onError={() => {}}
        initialCandidates={candidates}
      />,
    )
    fireEvent.click(screen.getByText('A DEBIT'))
    // First confirm click arms the warning ("Match anyway").
    fireEvent.click(screen.getByRole('button', { name: /^Match$/ }))
    const confirmBtn = await screen.findByRole('button', { name: /Match anyway/ })
    fireEvent.click(confirmBtn)
    await waitFor(() => {
      expect(api.postJson).toHaveBeenCalledWith('/api/dividends/1/match', { transactionId: 2 })
    })
    expect(onMatched).toHaveBeenCalled()
  })

  it('matches a clean transaction in one confirm click', async () => {
    vi.mocked(api.postJson).mockResolvedValue({ ok: true })
    const onMatched = vi.fn()
    render(
      <MatchDividendModal
        reconciliation={recon}
        onOpenChange={() => {}}
        onMatched={onMatched}
        onError={() => {}}
        initialCandidates={[candidate({ id: 9, merchant: 'CLEAN', amount: 100, warning: null })]}
      />,
    )
    fireEvent.click(screen.getByText('CLEAN'))
    fireEvent.click(screen.getByRole('button', { name: /^Match$/ }))
    await waitFor(() => {
      expect(api.postJson).toHaveBeenCalledWith('/api/dividends/1/match', { transactionId: 9 })
    })
    expect(onMatched).toHaveBeenCalled()
  })
})
