/**
 * The next cash obligation is stated, dated, and never overstated.
 *
 * Two facts drove this panel. First, "no instalments required" is a verdict a reader
 * will not believe without its reason — CRA's test has two conjuncts, and for 2026 it
 * is the second (neither 2024 nor 2025 cleared the threshold) that says he is not
 * late. Render the verdict without the reason and the panel looks like a bug.
 *
 * Second, the April balance-due date is the larger obligation in exactly that case,
 * and nothing in the app named it before.
 *
 * The hook is mocked rather than the network: these cases pin what the panel does with
 * a response shape, not how it fetches one.
 */
import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import type {
  InstalmentDueDto,
  InstalmentObligationDto,
  TaxOutlookDto,
} from '@cashflow/shared'

let outlook: TaxOutlookDto | null = null
let loading = false
let error: string | null = null

vi.mock('../../hooks/useTaxOutlook', () => ({
  useTaxOutlook: () => ({ data: outlook, loading, error, reload: vi.fn() }),
}))

import { OutlookPanel } from './OutlookPanel'

const QUARTERS: InstalmentDueDto[] = [
  { dueOn: '2026-03-15', amount: '4000.00' },
  { dueOn: '2026-06-15', amount: '4000.00' },
  { dueOn: '2026-09-15', amount: '4000.00' },
  { dueOn: '2026-12-15', amount: '4000.00' },
]

const NOT_REQUIRED_REASON =
  'Net tax owing for 2026 exceeds 3000.00, but neither 2025 (0.00) nor 2024 (0.00) did. '
  + 'CRA requires both, so no instalments are owed for 2026 — the whole amount is due with '
  + 'the return.'

function obligation(over: Partial<InstalmentObligationDto> = {}): InstalmentObligationDto {
  return {
    year: 2026,
    required: false,
    reason: NOT_REQUIRED_REASON,
    balanceDueOn: '2027-04-30',
    recommended: 'prior_year',
    instalments: [],
    options: [
      { basis: 'no_calculation', total: '0.00', balanceWithReturn: '16000.00', carriesInterestRisk: false, instalments: [] },
      { basis: 'prior_year', total: '0.00', balanceWithReturn: '16000.00', carriesInterestRisk: false, instalments: [] },
      { basis: 'current_year', total: '16000.00', balanceWithReturn: '0.00', carriesInterestRisk: true, instalments: QUARTERS },
    ],
    ...over,
  }
}

function outlookDto(over: Partial<TaxOutlookDto> = {}): TaxOutlookDto {
  return {
    year: 2026,
    netOwingByYear: { 2024: '0.00', 2025: '0.00', 2026: '8400.00' },
    projectedCurrentYearNetOwing: '16610.00',
    provenanceWarnings: [],
    obligation: obligation(),
    forward: {
      year: 2026,
      isProjection: true,
      currentTotalPayable: '8400.00',
      projectedTotalPayable: '16610.00',
      projectedAdditionalTax: '8210.00',
      draws: {
        actualToDate: '84000.00',
        monthlyRunRate: '14000.00',
        projectedRemainder: '84000.00',
        projectedTotal: '168000.00',
        coveredMonths: 6,
        uncoveredMonths: [],
        basis: 'Projected from 6 months of 2026 actuals, averaging $14,000.00 of draws per month, '
          + 'applied to the remaining 6 months.',
      },
    },
    ...over,
  }
}

const renderPanel = (d: TaxOutlookDto | null = outlookDto()) => {
  outlook = d
  loading = false
  error = null
  render(<OutlookPanel year={2026} />)
}

describe('OutlookPanel', () => {
  it('says no instalments are required and gives the reason verbatim', () => {
    // The reassurance is the payload. Summarising it to "not required" would drop the
    // two years the verdict rests on, and the reader cannot check a verdict he cannot
    // see the inputs to.
    renderPanel()
    expect(screen.getByText(/No instalments are required for 2026/)).toBeInTheDocument()
    expect(screen.getByText(NOT_REQUIRED_REASON)).toBeInTheDocument()
  })

  it('names the balance-due date, which nothing in the app named before', () => {
    renderPanel()
    expect(screen.getByText('2027-04-30')).toBeInTheDocument()
    expect(screen.getByText(/whole amount is due on this date/)).toBeInTheDocument()
  })

  it('lists four dated instalments with amounts when they are required', () => {
    renderPanel(outlookDto({
      obligation: obligation({
        required: true,
        reason: 'Net tax owing exceeds 3000.00 for 2026 and for at least one of 2025 and 2024, '
          + 'so quarterly instalments are required.',
        instalments: QUARTERS,
      }),
    }))
    expect(screen.getByText(/Quarterly instalments are required for 2026/)).toBeInTheDocument()
    for (const q of QUARTERS) expect(screen.getByText(q.dueOn)).toBeInTheDocument()
    expect(screen.getAllByText('$4,000.00')).toHaveLength(4)
  })

  it('shows no instalment schedule when none are owed', () => {
    // A schedule of zeroes would read as four payments to make. The options still
    // render — they are what he would owe if the threshold were met — but nothing
    // presents as due.
    renderPanel()
    expect(screen.queryByText('Instalments due')).not.toBeInTheDocument()
    expect(screen.queryByText('2026-03-15')).not.toBeInTheDocument()
  })

  it('marks the current-year option as carrying interest risk', () => {
    // It is the only option that can leave a shortfall CRA charges interest on. The
    // backend surfaces the flag rather than deciding for the taxpayer, so the panel
    // must render it as a caution, not bury it.
    renderPanel()
    expect(screen.getByText(/Current-year estimate/)).toBeInTheDocument()
    expect(screen.getByText(/Interest risk/)).toBeInTheDocument()
    expect(screen.getByText(/interest on the shortfall/)).toBeInTheDocument()
  })

  it('marks exactly the recommended option as recommended', () => {
    renderPanel()
    const badges = screen.getAllByText('Recommended')
    expect(badges).toHaveLength(1)
    // Prior-year is the recommendation, and the badge must sit on that option's row
    // rather than floating in the section heading.
    expect(badges[0].closest('li')).toHaveTextContent('Prior-year option')
  })

  it('renders all three calculation options with their totals', () => {
    renderPanel()
    expect(screen.getByText('No-calculation option')).toBeInTheDocument()
    expect(screen.getByText('Prior-year option')).toBeInTheDocument()
    expect(screen.getByText('Current-year estimate')).toBeInTheDocument()
    expect(screen.getByText('$16,000.00')).toBeInTheDocument()
  })

  it('labels the forward view a projection and renders its basis verbatim', () => {
    // The basis states the assumption and names any month with no transactions at
    // all. Paraphrasing it would erase the distinction between a month with no draws
    // and a missing statement, which is the whole reason the backend computes it.
    const dto = outlookDto()
    renderPanel(dto)
    expect(screen.getByText('Projection')).toBeInTheDocument()
    expect(screen.getByText(dto.forward.draws.basis)).toBeInTheDocument()
    expect(screen.getByText('$84,000.00')).toBeInTheDocument()
    expect(screen.getByText('$168,000.00')).toBeInTheDocument()
    expect(screen.getByText('$8,210.00')).toBeInTheDocument()
  })

  it('renders the uncovered-month sentence when the basis carries one', () => {
    const dto = outlookDto()
    const basis = `${dto.forward.draws.basis} May have no transactions at all and were `
      + 'projected rather than counted as zero — a missing statement is unknown, not empty.'
    dto.forward.draws.basis = basis
    dto.forward.draws.uncoveredMonths = [5]
    renderPanel(dto)
    expect(screen.getByText(basis)).toBeInTheDocument()
  })

  it('renders provenance warnings verbatim when there are any', () => {
    // 2024 is one of the two years that decided he owes nothing for 2026, and its
    // rate table was encoded from recall. The verdict is only as good as that.
    const warning = 'The 2024 rate table is a projection, not published figures, so the 0.00 net '
      + 'tax owing it produces — one of the inputs to the instalment threshold test — carries '
      + 'that uncertainty.'
    renderPanel(outlookDto({ provenanceWarnings: [warning] }))
    expect(screen.getByText(warning)).toBeInTheDocument()
  })

  it('renders no warning block when the array is empty', () => {
    renderPanel()
    expect(screen.queryByText(/carry uncertainty/)).not.toBeInTheDocument()
  })

  it('surfaces a failed load rather than reading as "nothing owed"', () => {
    // A year with no encoded rate table answers 409. Rendering nothing would look
    // identical to a clean verdict of no instalments required.
    outlook = null
    loading = false
    error = 'rate_table_missing'
    render(<OutlookPanel year={2099} />)
    expect(screen.getByText(/Failed to load the outlook/)).toBeInTheDocument()
    expect(screen.queryByText(/No instalments are required/)).not.toBeInTheDocument()
  })

  it('shows what each option leaves to pay with the return', () => {
    // Server-computed. The client must not find this by subtracting fixed-2 money
    // strings, and for a year that needs instalments there is no other way to know
    // what the April payment will be.
    renderPanel(outlookDto({
      obligation: obligation({
        required: true,
        options: [{
          basis: 'prior_year',
          total: '8400.00',
          balanceWithReturn: '8210.00',
          carriesInterestRisk: false,
          instalments: QUARTERS,
        }],
      }),
    }))
    expect(screen.getByText(/\$8,210\.00 left with the return/)).toBeInTheDocument()
  })
})
