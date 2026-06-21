import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { OpportunityCostCalculator } from './OpportunityCostCalculator'
import * as api from '@/lib/api'

void React

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return { ...actual, postJson: vi.fn() }
})

const sampleResult = {
  mode: 'one-time' as const,
  amount: 1000,
  cadence: 'monthly' as const,
  horizonYears: 10,
  annualReturnRate: 0.07,
  totalContributions: 1000,
  futureValue: 1967.15,
  gain: 967.15,
  monthlyEquivalent: 1000,
  assumptions: ['A one-time amount invested today at 7% annual return, compounded over 10 years.'],
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(api.postJson).mockResolvedValue(sampleResult)
})

describe('OpportunityCostCalculator', () => {
  it('renders the form with default inputs and a calculate button', () => {
    render(<OpportunityCostCalculator />)
    expect(screen.getByRole('button', { name: /calculate/i })).toBeInTheDocument()
    expect(screen.getByLabelText(/amount/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/return rate/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/time horizon|horizon/i)).toBeInTheDocument()
  })

  it('submits the percent rate as a decimal and posts the one-time payload', async () => {
    render(<OpportunityCostCalculator initialAmount={1000} />)

    fireEvent.change(screen.getByLabelText(/return rate/i), { target: { value: '7' } })
    fireEvent.change(screen.getByLabelText(/time horizon|horizon/i), { target: { value: '10' } })
    fireEvent.click(screen.getByRole('button', { name: /calculate/i }))

    await waitFor(() => expect(api.postJson).toHaveBeenCalledTimes(1))
    const [path, body] = vi.mocked(api.postJson).mock.calls[0]
    expect(path).toBe('/api/opportunity-cost/calculate')
    expect(body).toMatchObject({
      mode: 'one-time',
      amount: 1000,
      horizonYears: 10,
      annualReturnRate: 0.07, // 7% -> 0.07
    })
  })

  it('renders the future value and gain after calculating', async () => {
    render(<OpportunityCostCalculator initialAmount={1000} />)
    fireEvent.click(screen.getByRole('button', { name: /calculate/i }))

    await waitFor(() => expect(screen.getByText(/\$1,967\.15/)).toBeInTheDocument())
    // Gain is surfaced somewhere in the results.
    expect(screen.getByText(/\$967\.15/)).toBeInTheDocument()
  })

  it('shows the assumptions returned by the calculation', async () => {
    render(<OpportunityCostCalculator initialAmount={1000} />)
    fireEvent.click(screen.getByRole('button', { name: /calculate/i }))

    await waitFor(() =>
      expect(screen.getByText(/compounded over 10 years/i)).toBeInTheDocument(),
    )
  })

  it('switches to recurring mode and shows a cadence selector', async () => {
    render(<OpportunityCostCalculator />)
    // Recurring mode toggle.
    fireEvent.click(screen.getByRole('button', { name: /recurring/i }))
    expect(screen.getByLabelText(/cadence|frequency/i)).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText(/amount/i), { target: { value: '200' } })
    fireEvent.change(screen.getByLabelText(/cadence|frequency/i), { target: { value: 'monthly' } })
    fireEvent.change(screen.getByLabelText(/return rate/i), { target: { value: '6' } })
    fireEvent.change(screen.getByLabelText(/time horizon|horizon/i), { target: { value: '10' } })
    fireEvent.click(screen.getByRole('button', { name: /calculate/i }))

    await waitFor(() => expect(api.postJson).toHaveBeenCalledTimes(1))
    const [, body] = vi.mocked(api.postJson).mock.calls[0]
    expect(body).toMatchObject({
      mode: 'recurring',
      amount: 200,
      cadence: 'monthly',
      horizonYears: 10,
      annualReturnRate: 0.06,
    })
  })

  it('resets inputs back to defaults', async () => {
    render(<OpportunityCostCalculator initialAmount={500} />)
    const amount = screen.getByLabelText(/amount/i) as HTMLInputElement
    fireEvent.change(amount, { target: { value: '9999' } })
    expect(amount.value).toBe('9999')

    fireEvent.click(screen.getByRole('button', { name: /reset/i }))
    expect((screen.getByLabelText(/amount/i) as HTMLInputElement).value).toBe('500')
  })

  it('surfaces an error when the calculation fails', async () => {
    vi.mocked(api.postJson).mockRejectedValueOnce(new Error('amount must be a positive number.'))
    render(<OpportunityCostCalculator initialAmount={1000} />)
    fireEvent.click(screen.getByRole('button', { name: /calculate/i }))
    await waitFor(() =>
      expect(screen.getByText(/amount must be a positive number/i)).toBeInTheDocument(),
    )
  })
})
