import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, within, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ToastProvider } from '@/components/ui/toast'
import { IncomePage } from './IncomePage'
import { postJson } from '../lib/api'
import { todayDateInputValue } from '@/lib/dateInput'

vi.mock('../lib/api', () => ({
  getJson: vi.fn(() => Promise.resolve({ items: [], total: 0 })),
  postJson: vi.fn(() => Promise.resolve({})),
  patchJson: vi.fn(() => Promise.resolve({})),
  deleteReq: vi.fn(() => Promise.resolve(undefined)),
}))

/**
 * 03:30 UTC is late evening of the *previous* calendar day for behind-UTC
 * users (23:30 in UTC-4). Deriving the default via
 * `toISOString().slice(0, 10)` would pre-fill tomorrow's date for them;
 * `todayDateInputValue()` pre-fills the local day (issue #280).
 */
const EVENING_UTC_INSTANT = new Date('2026-06-16T03:30:00Z')

describe('IncomePage log dialog', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: EVENING_UTC_INSTANT, toFake: ['Date'] })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("defaults the date field to the user's local today", async () => {
    const user = userEvent.setup()
    render(
      <ToastProvider>
        <IncomePage />
      </ToastProvider>,
    )
    await user.click(await screen.findByRole('button', { name: /log income/i }))
    const dateInput = await screen.findByLabelText('Date')
    expect((dateInput as HTMLInputElement).value).toBe(todayDateInputValue())
  })

  it('blocks submit and shows an inline error for a negative gross amount', async () => {
    // AC #7: negative amount → inline "Amount can't be negative." + no POST.
    vi.mocked(postJson).mockClear()
    // userEvent needs real timers for typing; advance is incompatible with the
    // faked Date timers this suite installs, so run this case on real timers.
    vi.useRealTimers()
    const user = userEvent.setup()
    render(
      <ToastProvider>
        <IncomePage />
      </ToastProvider>,
    )
    await user.click(await screen.findByRole('button', { name: /log income/i }))
    const dialog = within(await screen.findByRole('dialog'))
    const grossInput = dialog.getByLabelText('Gross amount')
    // jsdom's userEvent strips the leading '-' from number inputs; set the raw
    // value directly to mimic a browser accepting a typed negative. Submit via
    // the form (a button click does not reliably fire onSubmit in jsdom).
    fireEvent.change(grossInput, { target: { value: '-50' } })
    fireEvent.submit((grossInput as HTMLElement).closest('form')!)

    expect(
      await dialog.findByText("Amount can't be negative."),
    ).toBeInTheDocument()
    expect(vi.mocked(postJson)).not.toHaveBeenCalled()
  })
})
