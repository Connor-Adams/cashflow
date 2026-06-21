import React from 'react'
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useConfirm } from './use-confirm'

function Harness({ onResult }: { onResult: (v: boolean) => void }) {
  const confirm = useConfirm()
  return (
    <div>
      <button onClick={async () => onResult(await confirm({ title: 'Delete it?', confirmLabel: 'Yes' }))}>
        ask
      </button>
      {confirm.dialog}
    </div>
  )
}

describe('useConfirm', () => {
  it('opens the dialog and resolves true on confirm', async () => {
    const user = userEvent.setup()
    let result: boolean | undefined
    render(<Harness onResult={(v) => (result = v)} />)

    await user.click(screen.getByRole('button', { name: 'ask' }))
    expect(screen.getByText('Delete it?')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Yes' }))
    expect(result).toBe(true)
  })

  it('resolves false on cancel', async () => {
    const user = userEvent.setup()
    let result: boolean | undefined
    render(<Harness onResult={(v) => (result = v)} />)

    await user.click(screen.getByRole('button', { name: 'ask' }))
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(result).toBe(false)
  })
})
