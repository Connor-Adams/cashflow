import { describe, it, expect } from 'vitest'
import { detectMode } from './importUtils'

describe('detectMode: Wealthsimple activity statement', () => {
  // The Custom Activity Statement is a single PDF covering every account. It
  // must NOT go to the pdf-bundle importer, which resolves one account per
  // file and would file every section against whichever account it matched
  // first.
  it('routes a single activity-statement PDF to its own mode', () => {
    const file = new File([''], 'ACTIVITY_STATEMENT_2026-06-02_2026-09-03.pdf')
    expect(detectMode([file])).toBe('activity-statement')
  })

  it('leaves ordinary statement PDFs on the bundle importer', () => {
    const files = [
      new File([''], 'Chequing Statement-4881 2026-08-05.pdf'),
      new File([''], 'C13BRX957CAD_identity-abc_2026-09_v_0.pdf'),
    ]
    expect(detectMode(files)).toBe('pdf-bundle')
  })

  it('does not claim a batch that merely includes an activity statement', () => {
    // Mixed uploads keep the per-file bundle path; the activity statement has
    // its own single-file endpoint.
    const files = [
      new File([''], 'ACTIVITY_STATEMENT_2026-06-02_2026-09-03.pdf'),
      new File([''], 'Chequing Statement-4881 2026-08-05.pdf'),
    ]
    expect(detectMode(files)).toBe('pdf-bundle')
  })
})
