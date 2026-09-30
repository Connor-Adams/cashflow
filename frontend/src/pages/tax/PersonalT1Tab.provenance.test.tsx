/**
 * The Personal T1 tab must show the year's actuals by default, and must say what
 * the number is when it is not actuals.
 *
 * Locks the prod defect: the tab auto-selected the most-recently-created
 * non-baseline scenario. For entity 1 / 2026 that was scenario 18, a
 * `projection_root` parented to the 2025 fork, which resolves through
 * `projectPersonalFactsFromPrevYear` and carries no 2026 transactions — its cached
 * CPP of 1,168.96 and EI of 384.23 can only be 2025 T4 income scaled forward.
 * Nothing on screen said so.
 */
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import type { CompletenessReportDto, TaxOutlookDto } from '@cashflow/shared'
import type { Scenario } from '../../hooks/useScenarios'

const NOW = new Date().toISOString()

function scenario(over: Partial<Scenario> & Pick<Scenario, 'id' | 'kind'>): Scenario {
  return {
    parentId: null,
    entityId: 1,
    year: 2026,
    name: `S${over.id}`,
    overrides: {},
    assumptions: {},
    nextYearId: null,
    notes: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  }
}

const BASELINE = scenario({ id: 11, kind: 'baseline', name: 'Baseline' })
const FORK = scenario({ id: 12, kind: 'fork', parentId: 11, name: 'Scratch' })
// Created last, parented to the *prior* year's fork — exactly prod's shape.
const PROJECTION = scenario({ id: 18, kind: 'projection_root', parentId: 2, name: 'Projection 2026' })

let scenarioList: Scenario[] = []
const detailIds: (number | null)[] = []
let detailFor: Scenario = BASELINE
let completeness: CompletenessReportDto | undefined
let outlook: TaxOutlookDto | null = null

vi.mock('../../hooks/useTaxEntities', () => ({
  useTaxEntities: () => ({ entities: [{ id: 1, kind: 'personal' }], error: null }),
}))
vi.mock('../../hooks/useScenarioChain', () => ({
  useScenarioChain: () => ({ chain: [], error: null, loading: false }),
}))
// Kept out of the network so these cases stay about the tab's own composition. The
// outlook's contents are pinned in OutlookPanel.test.tsx.
vi.mock('../../hooks/useTaxOutlook', () => ({
  useTaxOutlook: () => ({ data: outlook, loading: false, error: null, reload: vi.fn() }),
}))
vi.mock('../../hooks/useScenarios', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  useScenarios: () => ({
    scenarios: scenarioList,
    error: null,
    loading: false,
    reload: vi.fn(),
    create: vi.fn(),
    patch: vi.fn(),
    fork: vi.fn(),
    remove: vi.fn(),
    projectNextYear: vi.fn(),
  }),
  useScenarioDetail: (id: number | null) => {
    detailIds.push(id)
    if (id === null) return { data: null, error: null, loading: false, reload: vi.fn() }
    return {
      data: {
        scenario: detailFor,
        computed: {
          scenarioId: detailFor.id,
          factsHash: 'h',
          computedAt: NOW,
          lines: [],
          totals: { totalPayable: '300.00', refundOrOwing: '300.00', totalIncome: '27035.16', taxableIncome: '27035.16' },
          warnings: [],
          cached: true,
          completeness,
        },
      },
      error: null,
      loading: false,
      reload: vi.fn(),
    }
  },
}))

import { PersonalT1Tab } from './PersonalT1Tab'

describe('PersonalT1Tab provenance', () => {
  beforeEach(() => {
    detailIds.length = 0
    detailFor = BASELINE
  })

  it('defaults to the baseline even though the projection was created last', () => {
    scenarioList = [BASELINE, FORK, PROJECTION]
    render(<PersonalT1Tab year={2026} />)
    // The tab must ask for the baseline's detail, not the last-created scenario.
    expect(detailIds).toContain(11)
    expect(detailIds).not.toContain(18)
  })

  it('says what a projection is and what it lacks when one is selected', () => {
    scenarioList = [PROJECTION]
    detailFor = PROJECTION
    render(<PersonalT1Tab year={2026} />)
    expect(screen.getByText(/Projection from 2025/)).toBeInTheDocument()
    expect(screen.getByText(/Contains no transactions from 2026\./)).toBeInTheDocument()
  })

  it('labels an actuals baseline as actuals', () => {
    scenarioList = [BASELINE]
    detailFor = BASELINE
    render(<PersonalT1Tab year={2026} />)
    expect(screen.getByText(/Actuals/)).toBeInTheDocument()
    expect(screen.queryByText(/Contains no transactions/)).not.toBeInTheDocument()
  })
})

describe('PersonalT1Tab completeness', () => {
  beforeEach(() => {
    detailIds.length = 0
    detailFor = BASELINE
    scenarioList = [BASELINE]
  })

  it('renders the completeness block above the total', () => {
    // The ordering is the point: three investigations of "my tax looks too low" each
    // ended at incomplete data while this tab showed a clean number first.
    completeness = {
      status: 'blocked',
      checkedAt: '2026-09-29T00:00:00.000Z',
      coverageThrough: '2026-09-25',
      blockers: [{
        kind: 'unclassified_corp_draws',
        severity: 'blocker',
        title: '3 corp→personal transfers not classified',
        detail: 'Classify each as a dividend, salary, loan or reimbursement.',
        amount: '42000.00',
        taxEstimate: '4227.00',
        fix: { surface: 'classify', label: 'Classify these draws' },
        references: [1, 2, 3],
      }],
      gaps: [],
    }
    render(<MemoryRouter><PersonalT1Tab year={2026} /></MemoryRouter>)
    const block = screen.getByText(/This total is incomplete/)
    // "Total payable" appears twice — the headline StatCard and the humanized totals
    // list below it. The headline is the first, and it is the one that must not come
    // before the caveat.
    const total = screen.getAllByText(/Total payable/)[0]
    expect(block.compareDocumentPosition(total) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('renders the total with no block when the backend sends none', () => {
    // Corp scenarios carry no report, and an older cached client response may not
    // either. The tab must still render rather than blanking.
    completeness = undefined
    render(<MemoryRouter><PersonalT1Tab year={2026} /></MemoryRouter>)
    expect(screen.getAllByText(/Total payable/).length).toBeGreaterThan(0)
    expect(screen.queryByText(/This total is incomplete/)).not.toBeInTheDocument()
  })
})

describe('PersonalT1Tab outlook', () => {
  beforeEach(() => {
    detailIds.length = 0
    detailFor = BASELINE
    scenarioList = [BASELINE]
    completeness = undefined
    outlook = {
      year: 2026,
      netOwingByYear: { 2024: '0.00', 2025: '0.00', 2026: '8400.00' },
      projectedCurrentYearNetOwing: '16610.00',
      provenanceWarnings: [],
      obligation: {
        year: 2026,
        required: false,
        reason: 'No instalments are owed for 2026 — the whole amount is due with the return.',
        balanceDueOn: '2027-04-30',
        recommended: 'prior_year',
        instalments: [],
        options: [
          { basis: 'no_calculation', total: '0.00', carriesInterestRisk: false, instalments: [] },
          { basis: 'prior_year', total: '0.00', carriesInterestRisk: false, instalments: [] },
          { basis: 'current_year', total: '16610.00', carriesInterestRisk: true, instalments: [] },
        ],
      },
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
          basis: 'Projected from 6 months of 2026 actuals.',
        },
      },
    }
  })

  it('renders the outlook below the headline total, not above it', () => {
    // The ordering is the point and it is the opposite of completeness': completeness
    // qualifies the number, so it precedes it; the outlook says what the number means
    // next, so it follows it.
    render(<MemoryRouter><PersonalT1Tab year={2026} /></MemoryRouter>)
    const total = screen.getAllByText(/Total payable/)[0]
    const balanceDue = screen.getByText('2027-04-30')
    expect(total.compareDocumentPosition(balanceDue) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('renders nothing of the outlook when the endpoint gave nothing', () => {
    outlook = null
    render(<MemoryRouter><PersonalT1Tab year={2026} /></MemoryRouter>)
    expect(screen.getAllByText(/Total payable/).length).toBeGreaterThan(0)
    expect(screen.queryByText('Balance due')).not.toBeInTheDocument()
  })
})
