import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom'
import { DeleteAccountModal } from './DeleteAccountModal'
import * as api from '@/lib/api'

const HOUSEHOLD = 'The Adams Household'

function renderModal(overrides: Partial<Parameters<typeof DeleteAccountModal>[0]> = {}) {
  const onClose = vi.fn()
  const onDeleted = vi.fn()
  render(
    <DeleteAccountModal
      open
      householdName={HOUSEHOLD}
      onClose={onClose}
      onDeleted={onDeleted}
      {...overrides}
    />,
  )
  return { onClose, onDeleted }
}

describe('DeleteAccountModal', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('renders nothing when closed', () => {
    const { container } = render(
      <DeleteAccountModal
        open={false}
        householdName={HOUSEHOLD}
        onClose={vi.fn()}
        onDeleted={vi.fn()}
      />,
    )
    expect(container).toBeEmptyDOMElement()
  })

  it('disables the destructive confirm until the household name is typed exactly', async () => {
    renderModal()
    const confirmBtn = screen.getByRole('button', { name: /delete everything/i })
    expect(confirmBtn).toBeDisabled()

    const input = screen.getByLabelText(/household name confirmation/i)
    await userEvent.type(input, 'The Adams')
    expect(confirmBtn).toBeDisabled()

    await userEvent.clear(input)
    await userEvent.type(input, HOUSEHOLD)
    expect(confirmBtn).toBeEnabled()
  })

  it('calls deleteAccount with the household name and then onDeleted on success', async () => {
    const spy = vi.spyOn(api, 'deleteAccount').mockResolvedValue({
      deleted: true,
      householdId: 1,
      deletedUserIds: [1, 2],
      filesSwept: 3,
    })
    const { onDeleted } = renderModal()

    await userEvent.type(screen.getByLabelText(/household name confirmation/i), HOUSEHOLD)
    await userEvent.click(screen.getByRole('button', { name: /delete everything/i }))

    await waitFor(() => expect(spy).toHaveBeenCalledWith(HOUSEHOLD))
    await waitFor(() => expect(onDeleted).toHaveBeenCalledTimes(1))
  })

  it('surfaces an error and does not call onDeleted when the request fails', async () => {
    vi.spyOn(api, 'deleteAccount').mockRejectedValue(new Error('boom'))
    const { onDeleted } = renderModal()

    await userEvent.type(screen.getByLabelText(/household name confirmation/i), HOUSEHOLD)
    await userEvent.click(screen.getByRole('button', { name: /delete everything/i }))

    expect(await screen.findByRole('alert')).toHaveTextContent('boom')
    expect(onDeleted).not.toHaveBeenCalled()
  })
})
