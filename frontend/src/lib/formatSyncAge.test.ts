import { describe, it, expect } from 'vitest'
import { formatSyncAge } from './formatSyncAge'

const now = new Date('2026-06-15T12:00:00Z')

describe('formatSyncAge', () => {
  it('returns "Never synced" for null', () => {
    expect(formatSyncAge(null, now)).toBe('Never synced')
  })
  it('formats just-now and minutes', () => {
    expect(formatSyncAge('2026-06-15T11:59:40Z', now)).toBe('Synced just now')
    expect(formatSyncAge('2026-06-15T11:30:00Z', now)).toBe('Synced 30m ago')
  })
  it('formats hours and days', () => {
    expect(formatSyncAge('2026-06-15T09:00:00Z', now)).toBe('Synced 3h ago')
    expect(formatSyncAge('2026-06-13T12:00:00Z', now)).toBe('Synced 2d ago')
  })
})
