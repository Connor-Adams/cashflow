import { describe, it, expect } from 'vitest'
import { formatParseErrorLines } from './formatParseErrors'

describe('formatParseErrorLines', () => {
  it('maps errors to readable lines', () => {
    const lines = formatParseErrorLines([
      { rowIndex: 2, message: 'Invalid date: x' },
      { rowIndex: 4, message: 'Missing required columns' },
    ])
    expect(lines).toEqual([
      'Row 2: Invalid date: x',
      'Row 4: Missing required columns',
    ])
  })

  it('returns empty for empty input', () => {
    expect(formatParseErrorLines([])).toEqual([])
  })
})
