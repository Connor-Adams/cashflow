/**
 * The Overview headline is the refund or balance owing (L48500), not gross tax
 * before withholding (L43500). For 2025 the page showed "$3724.47" under
 * "Estimated total payable" when the return was a refund.
 */
import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

void React

let totals: Record<string, string> = {}

vi.mock('../../hooks/useTaxReturn', () => ({
  useTaxReturn: () => ({
    data: { cached: true, computedAt: new Date().toISOString(), lines: [], totals, warnings: [] },
    error: null,
    loading: false,
  }),
}))
vi.mock('../../hooks/useHouseholdPlanCompute', () => ({
  useHouseholdPlanCompute: () => ({ data: null, error: null, loading: false }),
}))
vi.mock('../../hooks/useTaxEntities', () => ({
  useTaxEntities: () => ({ entities: [], error: null, reload: vi.fn() }),
}))
vi.mock('./scenarios/HouseholdPlanPicker', () => ({ HouseholdPlanPicker: () => null }))
vi.mock('./MultiYearCompareCard', () => ({ MultiYearCompareCard: () => null }))
vi.mock('./InstalmentTracker', () => ({ InstalmentTracker: () => null }))

import { OverviewTab } from './OverviewTab'

const BASE = {
  federalTax: '2000.00',
  provincialTax: '1000.00',
  cppContrib: '500.00',
  eiPremium: '224.47',
  totalPayable: '3724.47',
}

function renderTab() {
  return render(<OverviewTab year={2025} activePlanId={null} onPlanChange={() => {}} />)
}

describe('OverviewTab headline', () => {
  it('headlines a negative refundOrOwing as a formatted refund', () => {
    totals = { ...BASE, refundOrOwing: '-1234.5' }
    renderTab()
    expect(screen.getByRole('heading', { name: /Year 2025 — Estimated refund/ })).toBeInTheDocument()
    expect(screen.getByText('$1,234.50')).toBeInTheDocument()
    expect(screen.queryByText(/Estimated total payable/)).not.toBeInTheDocument()
  })

  it('headlines a positive refundOrOwing as a formatted balance owing', () => {
    totals = { ...BASE, refundOrOwing: '812' }
    renderTab()
    expect(screen.getByRole('heading', { name: /Year 2025 — Estimated owing/ })).toBeInTheDocument()
    expect(screen.getByText('$812.00')).toBeInTheDocument()
  })

  it('keeps gross tax as a formatted secondary line labelled as before withholding', () => {
    totals = { ...BASE, refundOrOwing: '-1234.5' }
    renderTab()
    expect(screen.getByText(/Total tax before withholding: \$3,724\.47/)).toBeInTheDocument()
  })
})
