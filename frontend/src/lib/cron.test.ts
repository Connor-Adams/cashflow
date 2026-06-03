import { describe, expect, it } from 'vitest'
import { describeCron } from './cron'

describe('describeCron', () => {
  it('treats null, empty, and "manual" as Manual', () => {
    expect(describeCron(null)).toBe('Manual')
    expect(describeCron('')).toBe('Manual')
    expect(describeCron('manual')).toBe('Manual')
  })

  it('describes every-minute', () => {
    expect(describeCron('* * * * *')).toBe('Every minute')
    expect(describeCron('*/1 * * * *')).toBe('Every minute')
  })

  it('describes every-N-minutes', () => {
    expect(describeCron('*/4 * * * *')).toBe('Every 4 minutes')
    expect(describeCron('*/15 * * * *')).toBe('Every 15 minutes')
  })

  it('describes hourly (minute 0)', () => {
    expect(describeCron('0 * * * *')).toBe('Every hour')
  })

  it('describes every-N-hours', () => {
    expect(describeCron('0 */2 * * *')).toBe('Every 2 hours')
    expect(describeCron('0 */6 * * *')).toBe('Every 6 hours')
  })

  it('describes daily at a time', () => {
    expect(describeCron('0 3 * * *')).toBe('Daily at 3:00 AM')
    expect(describeCron('30 3 * * *')).toBe('Daily at 3:30 AM')
    expect(describeCron('0 12 * * *')).toBe('Daily at 12:00 PM')
    expect(describeCron('0 0 * * *')).toBe('Daily at 12:00 AM')
    expect(describeCron('0 14 * * *')).toBe('Daily at 2:00 PM')
  })

  it('describes weekly on a single weekday', () => {
    expect(describeCron('0 9 * * 1')).toBe('Mondays at 9:00 AM')
    expect(describeCron('0 9 * * 0')).toBe('Sundays at 9:00 AM')
    expect(describeCron('0 9 * * 7')).toBe('Sundays at 9:00 AM')
    expect(describeCron('0 17 * * 5')).toBe('Fridays at 5:00 PM')
  })

  it('falls back to the raw expression for unsupported patterns', () => {
    expect(describeCron('0 0 1 * *')).toBe('0 0 1 * *')
    expect(describeCron('15 10 * * 1-5')).toBe('15 10 * * 1-5')
    expect(describeCron('not a cron')).toBe('not a cron')
  })
})
