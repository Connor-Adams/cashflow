/**
 * Provenance of the number the Personal T1 tab renders.
 *
 * The defect these lock: the tab auto-selected the last-created non-baseline
 * scenario. In prod that was a `projection_root` parented to the *prior* year's
 * fork, which resolves through `projectPersonalFactsFromPrevYear` and therefore
 * carries no transactions from the year on screen. It rendered identically to an
 * actuals baseline, so a 2025-scaled forecast read as the 2026 return.
 */
import { describe, it, expect } from 'vitest'
import { pickDefaultScenarioId, describeProvenance } from './provenance'
import type { Scenario } from '../../../hooks/useScenarios'

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

describe('pickDefaultScenarioId', () => {
  it('selects the baseline even when a projection was created later', () => {
    // Prod shape for entity 1 / 2026: baseline 11, fork 12, then projection 18.
    const scenarios = [
      scenario({ id: 11, kind: 'baseline' }),
      scenario({ id: 12, kind: 'fork', parentId: 11 }),
      scenario({ id: 18, kind: 'projection_root', parentId: 2 }),
    ]
    expect(pickDefaultScenarioId(scenarios)).toBe(11)
  })

  it('selects the baseline even when a fork was created later', () => {
    const scenarios = [
      scenario({ id: 11, kind: 'baseline' }),
      scenario({ id: 12, kind: 'fork', parentId: 11 }),
    ]
    expect(pickDefaultScenarioId(scenarios)).toBe(11)
  })

  it('falls back to the first scenario when there is no baseline', () => {
    const scenarios = [
      scenario({ id: 18, kind: 'projection_root' }),
      scenario({ id: 19, kind: 'fork', parentId: 18 }),
    ]
    expect(pickDefaultScenarioId(scenarios)).toBe(18)
  })

  it('returns null for an empty list', () => {
    expect(pickDefaultScenarioId([])).toBeNull()
  })
})

describe('describeProvenance', () => {
  it('labels a baseline as actuals, with no caveat', () => {
    const p = describeProvenance(scenario({ id: 11, kind: 'baseline' }))
    expect(p.label).toBe('Actuals')
    expect(p.caveat).toBeNull()
    expect(p.isProjection).toBe(false)
  })

  it('labels a fork as actuals plus overrides', () => {
    const p = describeProvenance(scenario({ id: 12, kind: 'fork', parentId: 11 }))
    expect(p.label).toBe('Actuals + overrides')
    expect(p.caveat).toBeNull()
    expect(p.isProjection).toBe(false)
  })

  it('labels a projection with the year it was scaled from, and says what it lacks', () => {
    const p = describeProvenance(scenario({ id: 18, kind: 'projection_root', year: 2026 }))
    expect(p.label).toBe('Projection from 2025')
    expect(p.caveat).toBe('Contains no transactions from 2026.')
    expect(p.isProjection).toBe(true)
  })
})
