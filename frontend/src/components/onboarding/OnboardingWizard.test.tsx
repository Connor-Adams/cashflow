import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom'
import { MemoryRouter } from 'react-router-dom'
import { ToastProvider } from '@/components/ui/toast'
import { OnboardingWizard } from './OnboardingWizard'
import { shouldShowWizard } from './shouldShowWizard'
import type { Account } from '@/types/api'
import * as api from '@/lib/api'

const navigateMock = vi.fn()
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom')
  return { ...actual, useNavigate: () => navigateMock }
})

function renderWizard(onDone = vi.fn()) {
  return render(
    <MemoryRouter>
      <ToastProvider>
        <OnboardingWizard onDone={onDone} />
      </ToastProvider>
    </MemoryRouter>,
  )
}

const csvFile = () =>
  new File(['Date,Description,Amount\n2025-01-01,Coffee,-4.5\n'], 'statement.csv', {
    type: 'text/csv',
  })

function makeAccount(over: Partial<Account> = {}): Account {
  return {
    id: 1,
    name: 'Chequing',
    owner: 'me',
    householdId: 1,
    ownerUserId: 1,
    visibility: 'private',
    accountType: 'checking',
    shortCode: null,
    defaultCurrency: 'CAD',
    closedAt: null,
    ...over,
  }
}

describe('shouldShowWizard (AC #1, #2)', () => {
  it('shows when zero accounts and dismissed_at is null', () => {
    expect(shouldShowWizard([], { onboardingDismissedAt: null })).toBe(true)
  })

  it('does NOT show when an active account exists', () => {
    expect(
      shouldShowWizard([makeAccount()], { onboardingDismissedAt: null }),
    ).toBe(false)
  })

  it('does NOT show once dismissed, even with zero accounts (AC #3)', () => {
    expect(
      shouldShowWizard([], { onboardingDismissedAt: '2026-05-30T00:00:00.000Z' }),
    ).toBe(false)
  })

  it('treats archived-only accounts as empty (edge case)', () => {
    const archived = makeAccount({ closedAt: '2025-01-01' })
    expect(shouldShowWizard([archived], { onboardingDismissedAt: null })).toBe(true)
  })

  it('does NOT re-show after dismissal even if an account was later created', () => {
    expect(
      shouldShowWizard([makeAccount()], {
        onboardingDismissedAt: '2026-05-30T00:00:00.000Z',
      }),
    ).toBe(false)
  })
})

describe('OnboardingWizard', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    navigateMock.mockReset()
  })

  it('renders the headline, primary CTA, and skip link', () => {
    renderWizard()
    expect(screen.getByText(/let's get your money in one place/i)).toBeInTheDocument()
    expect(screen.getByText('Drop your first statement')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /skip for now/i })).toBeInTheDocument()
  })

  it('Skip for now PATCHes the dismiss endpoint and calls onDone (AC #3)', async () => {
    const patchSpy = vi
      .spyOn(api, 'patchJson')
      .mockResolvedValue({ dismissedAt: '2026-05-30T00:00:00.000Z' } as never)
    const onDone = vi.fn()
    renderWizard(onDone)

    await userEvent.click(screen.getByRole('button', { name: /skip for now/i }))

    await waitFor(() =>
      expect(patchSpy).toHaveBeenCalledWith('/api/preferences/onboarding-dismiss', {}),
    )
    expect(onDone).toHaveBeenCalled()
  })

  it('uploading a file POSTs initial-import, then redirects + toasts on success (AC #6)', async () => {
    const postSpy = vi.spyOn(api, 'postFormData').mockResolvedValue({
      accountId: 5,
      importedCount: 12,
      accountName: 'Amex',
      accountCreated: true,
    } as never)
    const onDone = vi.fn()
    renderWizard(onDone)

    const input = screen.getByTestId('onboarding-file-input') as HTMLInputElement
    await userEvent.upload(input, csvFile())

    await waitFor(() =>
      expect(postSpy).toHaveBeenCalledWith('/api/onboarding/initial-import', expect.any(FormData)),
    )
    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith('/transactions'))
    expect(onDone).toHaveBeenCalled()
    expect(await screen.findByText(/imported 12 transactions to amex/i)).toBeInTheDocument()
  })

  it('reveals the name/type form when the backend cannot infer (AC #5)', async () => {
    vi.spyOn(api, 'postFormData').mockRejectedValueOnce(
      new Error('We could not detect an account name from this file.'),
    )
    renderWizard()

    const input = screen.getByTestId('onboarding-file-input') as HTMLInputElement
    await userEvent.upload(input, csvFile())

    expect(await screen.findByLabelText(/account name/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/account type/i)).toBeInTheDocument()
  })

  it('shows UNSUPPORTED_FORMAT copy with a manual-setup link (AC #7)', async () => {
    vi.spyOn(api, 'postFormData').mockRejectedValue(
      new Error("We don't recognize this format. Supported: CSV, OFX, QIF."),
    )
    renderWizard()

    const input = screen.getByTestId('onboarding-file-input') as HTMLInputElement
    await userEvent.upload(input, csvFile())

    expect(
      await screen.findByText(/we don't recognize this format\. supported: csv, ofx, qif\./i),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /set up account manually/i })).toBeInTheDocument()
  })

  it('shows a NO_TRANSACTIONS message distinct from a parse failure (AC #8)', async () => {
    vi.spyOn(api, 'postFormData').mockRejectedValue(
      new Error('Your file parsed but no transactions were found.'),
    )
    renderWizard()

    const input = screen.getByTestId('onboarding-file-input') as HTMLInputElement
    await userEvent.upload(input, csvFile())

    expect(
      await screen.findByText(/parsed but no transactions were found/i),
    ).toBeInTheDocument()
  })

  it('drop target, file picker, and skip link are keyboard reachable (AC #9)', async () => {
    renderWizard()
    const dropTarget = screen.getByRole('button', {
      name: /drop your first statement, or press enter to choose a file/i,
    })
    const chooseBtn = screen.getByRole('button', { name: 'Choose a file' })
    const skipBtn = screen.getByRole('button', { name: /skip for now/i })

    // All three are in the tab order (not tabindex=-1).
    expect(dropTarget).toHaveAttribute('tabindex', '0')
    expect(chooseBtn).not.toHaveAttribute('tabindex', '-1')
    expect(skipBtn).not.toHaveAttribute('tabindex', '-1')

    // Enter on the drop target opens the file picker.
    const input = screen.getByTestId('onboarding-file-input') as HTMLInputElement
    const clickSpy = vi.spyOn(input, 'click').mockImplementation(() => {})
    dropTarget.focus()
    await userEvent.keyboard('{Enter}')
    expect(clickSpy).toHaveBeenCalled()
  })
})
