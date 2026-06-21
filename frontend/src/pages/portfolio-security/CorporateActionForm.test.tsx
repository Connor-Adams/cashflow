import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { CorporateActionForm } from './CorporateActionForm'
import * as api from '../../lib/api'

const accounts = [{ accountId: 7, accountName: 'TFSA' }]

function open() {
  fireEvent.click(screen.getByRole('button', { name: /add corporate action/i }))
}

function setType(value: string) {
  fireEvent.change(screen.getByLabelText('Activity type'), { target: { value } })
}

describe('CorporateActionForm', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.spyOn(api, 'getJson').mockResolvedValue({
      securities: [
        { id: 1, symbol: 'PRNT', name: 'Parent Co' },
        { id: 2, symbol: 'CHLD', name: 'Child Co' },
      ],
    } as never)
  })

  it('selecting Spin-off reveals recipient, allocation, and shares; hides ROC amount', async () => {
    render(<CorporateActionForm securityId={1} accounts={accounts} onSubmitted={vi.fn()} />)
    open()
    setType('spin_off')
    expect(screen.getByLabelText('Shares received')).toBeInTheDocument()
    expect(screen.getByLabelText('New security')).toBeInTheDocument()
    expect(
      screen.getByLabelText('% of cost basis allocated to new security (0–1)'),
    ).toBeInTheDocument()
    expect(screen.queryByLabelText('Amount returned')).not.toBeInTheDocument()
  })

  it('Return of capital shows only the amount field', () => {
    render(<CorporateActionForm securityId={1} accounts={accounts} onSubmitted={vi.fn()} />)
    open()
    setType('return_of_capital')
    expect(screen.getByLabelText('Amount returned')).toBeInTheDocument()
    expect(screen.queryByLabelText('Shares received')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('New security')).not.toBeInTheDocument()
  })

  it('allocation 1.5 shows the inline error and disables submit', async () => {
    render(<CorporateActionForm securityId={1} accounts={accounts} onSubmitted={vi.fn()} />)
    open()
    setType('spin_off')
    fireEvent.change(screen.getByLabelText('Date'), { target: { value: '2024-06-01' } })
    fireEvent.change(screen.getByLabelText('Shares received'), { target: { value: '5' } })
    // Recipient options arrive async via getJson — wait for the option to mount.
    await waitFor(() =>
      expect(
        (screen.getByLabelText('New security') as HTMLSelectElement).querySelector(
          'option[value="2"]',
        ),
      ).not.toBeNull(),
    )
    fireEvent.change(screen.getByLabelText('New security'), { target: { value: '2' } })
    fireEvent.change(
      screen.getByLabelText('% of cost basis allocated to new security (0–1)'),
      { target: { value: '1.5' } },
    )
    expect(screen.getByText('Allocation must be between 0 and 1.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /save corporate action/i })).toBeDisabled()
  })

  it('a valid dividend_in_kind submit POSTs the right body and reloads', async () => {
    const postSpy = vi.spyOn(api, 'postJson').mockResolvedValue({
      activity: {}, recipientActivity: null,
    } as never)
    const onSubmitted = vi.fn()
    render(<CorporateActionForm securityId={1} accounts={accounts} onSubmitted={onSubmitted} />)
    open()
    // default type is dividend_in_kind
    fireEvent.change(screen.getByLabelText('Date'), { target: { value: '2024-03-01' } })
    fireEvent.change(screen.getByLabelText('Shares received'), { target: { value: '2' } })
    fireEvent.click(screen.getByRole('button', { name: /save corporate action/i }))

    await waitFor(() => expect(postSpy).toHaveBeenCalled())
    expect(postSpy).toHaveBeenCalledWith('/api/portfolio/activities', {
      accountId: 7,
      securityId: 1,
      activityType: 'dividend_in_kind',
      tradeDate: '2024-03-01',
      quantity: 2,
    })
    await waitFor(() => expect(onSubmitted).toHaveBeenCalled())
  })

  it('imported types (buy/sell/split/DRIP) cannot be saved manually', () => {
    render(<CorporateActionForm securityId={1} accounts={accounts} onSubmitted={vi.fn()} />)
    open()
    setType('buy')
    expect(screen.getByText(/come from imports/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /save corporate action/i })).toBeDisabled()
  })
})
