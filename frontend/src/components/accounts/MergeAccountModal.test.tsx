import React from 'react'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MergeAccountModal } from './MergeAccountModal'
import type { Account } from '../../types/api'

const postJson = vi.fn()
vi.mock('../../lib/api', () => ({
  postJson: (...args: unknown[]) => postJson(...args),
}))

function acct(partial: Partial<Account> & { id: number; name: string }): Account {
  return {
    owner: 'me',
    householdId: null,
    ownerUserId: null,
    visibility: 'shared',
    accountType: 'checking',
    shortCode: null,
    defaultCurrency: 'CAD',
    closedAt: null,
    mergedIntoId: null,
    mergedAt: null,
    ...partial,
  }
}

const source = acct({ id: 1, name: 'Old BoA' })
const targetCad = acct({ id: 2, name: 'New BoA', defaultCurrency: 'CAD' })
const targetUsd = acct({ id: 3, name: 'USD acct', defaultCurrency: 'USD' })

describe('MergeAccountModal', () => {
  beforeEach(() => {
    postJson.mockReset()
  })

  it('renders the modal title + preview totals once a target is picked (AC #11)', async () => {
    render(
      <MergeAccountModal source={source} accounts={[source, targetCad]} onClose={() => {}} onMerged={() => {}} />,
    )
    expect(screen.getByText('Merge accounts')).toBeInTheDocument()
    // Pick a target → preview text appears.
    fireEvent.change(screen.getByLabelText(/merge into/i), { target: { value: '2' } })
    expect(await screen.findByTestId('merge-preview')).toHaveTextContent(/New BoA/)
  })

  it('disables Merge until a same-currency target is selected (AC #12)', async () => {
    render(
      <MergeAccountModal source={source} accounts={[source, targetCad]} onClose={() => {}} onMerged={() => {}} />,
    )
    const mergeBtn = screen.getByRole('button', { name: /^merge$/i })
    expect(mergeBtn).toBeDisabled()
    fireEvent.change(screen.getByLabelText(/merge into/i), { target: { value: '2' } })
    expect(mergeBtn).toBeEnabled()
  })

  it('excludes different-currency accounts from the target list', () => {
    render(
      <MergeAccountModal
        source={source}
        accounts={[source, targetUsd]}
        onClose={() => {}}
        onMerged={() => {}}
      />,
    )
    // No same-currency target → empty-state message, no select.
    expect(screen.getByText(/at least two same-currency accounts/i)).toBeInTheDocument()
    expect(screen.queryByText('USD acct')).not.toBeInTheDocument()
  })

  it('warns the merge is not reversible', () => {
    render(
      <MergeAccountModal source={source} accounts={[source, targetCad]} onClose={() => {}} onMerged={() => {}} />,
    )
    expect(screen.getByText(/not currently reversible/i)).toBeInTheDocument()
  })

  it('calls the merge endpoint and reports the result on confirm', async () => {
    postJson.mockResolvedValue({
      source: { ...source, mergedIntoId: 2 },
      target: targetCad,
      movedTransactions: 4,
      movedPlannedEvents: 1,
      movedTotal: 5,
    })
    const onMerged = vi.fn()
    render(
      <MergeAccountModal source={source} accounts={[source, targetCad]} onClose={() => {}} onMerged={onMerged} />,
    )
    fireEvent.change(screen.getByLabelText(/merge into/i), { target: { value: '2' } })
    fireEvent.click(screen.getByRole('button', { name: /^merge$/i }))
    await waitFor(() => expect(onMerged).toHaveBeenCalledTimes(1))
    expect(postJson).toHaveBeenCalledWith('/api/accounts/1/merge-into/2', {})
    expect(onMerged.mock.calls[0][0].movedTransactions).toBe(4)
  })

  it('surfaces a currency-mismatch error inline', async () => {
    postJson.mockRejectedValue(new Error('CURRENCY_MISMATCH'))
    render(
      <MergeAccountModal source={source} accounts={[source, targetCad]} onClose={() => {}} onMerged={() => {}} />,
    )
    fireEvent.change(screen.getByLabelText(/merge into/i), { target: { value: '2' } })
    fireEvent.click(screen.getByRole('button', { name: /^merge$/i }))
    expect(await screen.findByText(/must be in the same currency/i)).toBeInTheDocument()
  })
})
