import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom'
import { CashflowTab } from './CashflowTab'
import * as api from '@/lib/api'
import { _resetAppConfigForTest } from '@/lib/appConfig'
import type { CashflowSettings } from '@/types/api'

const SETTINGS: CashflowSettings = {
  minimumCashBuffer: '250.0000',
  safeToSpendWindowDays: 14,
  includeCreditCardBalance: true,
  includeGoalContributions: true,
  counterpartyPromotionThreshold: 3,
  excludeNonPartnerInflows: true,
  largePurchaseThreshold: '500.0000',
  assumedAnnualReturnRate: '0.0500',
  onboardingDismissedAt: null,
}

function mockLoad(settings: CashflowSettings = SETTINGS) {
  return vi.spyOn(api, 'getJson').mockResolvedValue(settings as never)
}

function mockSave() {
  return vi
    .spyOn(api, 'patchJson')
    .mockImplementation(async (_path, body) => ({ ...SETTINGS, ...(body as object) }) as never)
}

async function renderLoaded() {
  render(<CashflowTab />)
  await screen.findByRole('heading', { name: 'Cashflow' })
}

describe('CashflowTab', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    _resetAppConfigForTest()
    window.__APP_CONFIG__ = {
      logoDevToken: null,
      quoteProviderConfigured: true,
      vapidPublicKey: null,
      emailConfigured: false,
      defaultCurrency: 'USD',
    }
  })

  it('renders every setting, grouped, with the saved values', async () => {
    mockLoad()
    await renderLoaded()

    expect(screen.getByText('Safe to spend')).toBeInTheDocument()
    expect(screen.getByText('Surplus')).toBeInTheDocument()
    expect(screen.getByText('Large purchases')).toBeInTheDocument()
    expect(screen.getByText('Partner fairness')).toBeInTheDocument()

    expect(screen.getByLabelText('Minimum cash buffer')).toHaveValue('250.00')
    expect(screen.getByLabelText('Look-ahead window')).toHaveValue(14)
    expect(screen.getByRole('switch', { name: 'Reserve credit-card payments' })).toHaveAttribute(
      'aria-checked',
      'true',
    )
    expect(screen.getByRole('switch', { name: 'Reserve goal contributions' })).toHaveAttribute(
      'aria-checked',
      'true',
    )
    // Stored as a decimal, shown as a percent.
    expect(screen.getByLabelText('Assumed investment return')).toHaveValue(5)
    expect(screen.getByLabelText('Large purchase threshold')).toHaveValue('500.00')
    expect(
      screen.getByRole('switch', { name: 'Exclude non-partner inflows' }),
    ).toHaveAttribute('aria-checked', 'true')

    expect(
      screen.getByText(/Keep at least this much cash untouched when computing safe-to-spend/),
    ).toBeInTheDocument()
  })

  it('labels money inputs with the household currency', async () => {
    mockLoad()
    await renderLoaded()
    // MoneyInput renders the ISO code as a suffix — one per money field.
    expect(screen.getAllByText('USD')).toHaveLength(2)
  })

  it('does not expose the counterparty promotion threshold (no UI surfaces it)', async () => {
    mockLoad()
    await renderLoaded()
    expect(screen.queryByText(/promot/i)).not.toBeInTheDocument()
  })

  it('keeps Save disabled until something changes', async () => {
    mockLoad()
    await renderLoaded()
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled()
  })

  type Case = [string, (user: ReturnType<typeof userEvent.setup>) => Promise<void>, object]
  const cases: Case[] = [
    [
      'minimumCashBuffer',
      async (user) => {
        const input = screen.getByLabelText('Minimum cash buffer')
        await user.clear(input)
        await user.type(input, '1000')
      },
      { minimumCashBuffer: 1000 },
    ],
    [
      'safeToSpendWindowDays',
      async (user) => {
        const input = screen.getByLabelText('Look-ahead window')
        await user.clear(input)
        await user.type(input, '30')
      },
      { safeToSpendWindowDays: 30 },
    ],
    [
      'includeCreditCardBalance',
      async (user) => {
        await user.click(screen.getByRole('switch', { name: 'Reserve credit-card payments' }))
      },
      { includeCreditCardBalance: false },
    ],
    [
      'includeGoalContributions',
      async (user) => {
        await user.click(screen.getByRole('switch', { name: 'Reserve goal contributions' }))
      },
      { includeGoalContributions: false },
    ],
    [
      'assumedAnnualReturnRate',
      async (user) => {
        const input = screen.getByLabelText('Assumed investment return')
        await user.clear(input)
        await user.type(input, '7.5')
      },
      { assumedAnnualReturnRate: 0.075 },
    ],
    [
      'largePurchaseThreshold',
      async (user) => {
        const input = screen.getByLabelText('Large purchase threshold')
        await user.clear(input)
        await user.type(input, '1200')
      },
      { largePurchaseThreshold: 1200 },
    ],
    [
      'excludeNonPartnerInflows',
      async (user) => {
        await user.click(screen.getByRole('switch', { name: 'Exclude non-partner inflows' }))
      },
      { excludeNonPartnerInflows: false },
    ],
  ]

  it.each(cases)('saves %s via PATCH /api/settings/cashflow', async (_field, edit, expected) => {
    const user = userEvent.setup()
    mockLoad()
    const save = mockSave()
    await renderLoaded()

    await edit(user)
    await user.click(screen.getByRole('button', { name: 'Save changes' }))

    await waitFor(() => expect(save).toHaveBeenCalledTimes(1))
    // Only the changed field is sent.
    expect(save).toHaveBeenCalledWith('/api/settings/cashflow', expected)
    expect(await screen.findByText('Saved')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled()
  })

  it('shows the server validation error and keeps the edit when the save is rejected', async () => {
    const user = userEvent.setup()
    mockLoad()
    vi.spyOn(api, 'patchJson').mockRejectedValue(
      new api.ApiError(
        'minimumCashBuffer must be a non-negative number no greater than 1000000000',
        400,
        '/api/settings/cashflow',
        null,
      ),
    )
    await renderLoaded()

    const input = screen.getByLabelText('Minimum cash buffer')
    await user.clear(input)
    await user.type(input, '900')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))

    expect(
      await screen.findByText(/Minimum cash buffer must be a non-negative number/),
    ).toBeInTheDocument()
    expect(screen.queryByText('Saved')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeEnabled()
  })

  it('flags an out-of-range value inline and blocks the save', async () => {
    const user = userEvent.setup()
    mockLoad()
    const save = mockSave()
    await renderLoaded()

    const input = screen.getByLabelText('Look-ahead window')
    await user.clear(input)
    await user.type(input, '400')

    expect(screen.getByText('Enter a whole number of days from 1 to 365.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled()
    expect(save).not.toHaveBeenCalled()
  })

  it('shows a retry when the settings fail to load', async () => {
    const user = userEvent.setup()
    const get = vi.spyOn(api, 'getJson').mockRejectedValueOnce(new Error('boom'))
    render(<CashflowTab />)
    expect(await screen.findByText('Couldn’t load cashflow settings.')).toBeInTheDocument()

    get.mockResolvedValue(SETTINGS as never)
    await user.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByRole('heading', { name: 'Cashflow' })).toBeInTheDocument()
  })
})
