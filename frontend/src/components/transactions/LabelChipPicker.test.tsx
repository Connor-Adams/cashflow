import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { LabelChipPicker } from './LabelChipPicker'
import * as api from '../../lib/api'
import type { Label, TransactionLabelRef } from '../../types/api'

function setup(overrides?: {
  value?: TransactionLabelRef[]
  available?: Label[]
}) {
  const onChange = vi.fn()
  const onLabelsMutated = vi.fn()
  render(
    <LabelChipPicker
      transactionId={42}
      value={overrides?.value ?? []}
      availableLabels={
        overrides?.available ?? [
          { id: 1, name: 'tax-deductible', usageCount: 3 },
          { id: 2, name: 'vacation-2026', usageCount: 1 },
        ]
      }
      onChange={onChange}
      onLabelsMutated={onLabelsMutated}
    />,
  )
  return { onChange, onLabelsMutated }
}

describe('LabelChipPicker', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('applies an existing label when picked from the dropdown', async () => {
    const setSpy = vi
      .spyOn(api, 'postJson')
      .mockResolvedValue({ labels: [{ id: 1, name: 'tax-deductible' }] })
    const { onChange } = setup()

    await userEvent.click(screen.getByPlaceholderText('Add label…'))
    await userEvent.type(screen.getByPlaceholderText('Add label…'), 'tax')
    // dropdown shows the match
    const option = await screen.findByRole('option', { name: /tax-deductible/i })
    await userEvent.click(option)

    await waitFor(() => {
      expect(setSpy).toHaveBeenCalledWith('/api/transactions/42/labels', {
        labelIds: [1],
      })
    })
    expect(onChange).toHaveBeenCalledWith([{ id: 1, name: 'tax-deductible' }])
  })

  it('creates a new label and applies it in one action when typing a name not in the list and pressing Enter (AC #10)', async () => {
    const postSpy = vi.spyOn(api, 'postJson')
    // First call: create the label. Second call: set it on the transaction.
    postSpy
      .mockResolvedValueOnce({ id: 99, name: 'reimbursable', usageCount: 0 })
      .mockResolvedValueOnce({ labels: [{ id: 99, name: 'reimbursable' }] })
    const { onChange, onLabelsMutated } = setup()

    const input = screen.getByPlaceholderText('Add label…')
    await userEvent.type(input, 'reimbursable')
    await userEvent.keyboard('{Enter}')

    await waitFor(() => {
      // creates the label
      expect(postSpy).toHaveBeenNthCalledWith(1, '/api/labels', { name: 'reimbursable' })
      // then sets it on the transaction
      expect(postSpy).toHaveBeenNthCalledWith(2, '/api/transactions/42/labels', {
        labelIds: [99],
      })
    })
    expect(onChange).toHaveBeenCalledWith([{ id: 99, name: 'reimbursable' }])
    // refreshes the shared label list so the new label shows elsewhere
    expect(onLabelsMutated).toHaveBeenCalled()
  })

  it('removes an applied label when its × is clicked', async () => {
    const setSpy = vi.spyOn(api, 'postJson').mockResolvedValue({ labels: [] })
    const { onChange } = setup({ value: [{ id: 1, name: 'tax-deductible' }] })

    await userEvent.click(screen.getByRole('button', { name: /remove tax-deductible/i }))

    await waitFor(() => {
      expect(setSpy).toHaveBeenCalledWith('/api/transactions/42/labels', { labelIds: [] })
    })
    expect(onChange).toHaveBeenCalledWith([])
  })

  it('shows an inline error and does not call the API when the typed name exceeds 32 chars', async () => {
    const postSpy = vi.spyOn(api, 'postJson')
    setup()

    const input = screen.getByPlaceholderText('Add label…')
    await userEvent.type(input, 'a'.repeat(33))
    await userEvent.keyboard('{Enter}')

    expect(
      await screen.findByText('Label names must be 32 characters or fewer.'),
    ).toBeInTheDocument()
    expect(postSpy).not.toHaveBeenCalled()
  })

  it('matches an existing label case-insensitively instead of creating a duplicate', async () => {
    const postSpy = vi
      .spyOn(api, 'postJson')
      .mockResolvedValue({ labels: [{ id: 1, name: 'tax-deductible' }] })
    const { onChange } = setup()

    const input = screen.getByPlaceholderText('Add label…')
    // type a case variant of an existing label, press Enter
    await userEvent.type(input, 'Tax-Deductible')
    await userEvent.keyboard('{Enter}')

    await waitFor(() => {
      // only the set call — NO create call, because the label already exists
      expect(postSpy).toHaveBeenCalledTimes(1)
      expect(postSpy).toHaveBeenCalledWith('/api/transactions/42/labels', { labelIds: [1] })
    })
    expect(onChange).toHaveBeenCalledWith([{ id: 1, name: 'tax-deductible' }])
  })
})
