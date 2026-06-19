import { describe, expect, it } from 'vitest'
import type { ForecastEvent } from '../types/api'
import {
  MAX_VISIBLE_DRIVERS,
  deriveDipDrivers,
  driverLinkTarget,
} from './forecastDrivers'

function ev(partial: Partial<ForecastEvent>): ForecastEvent {
  return {
    date: '2026-07-01',
    amount: 100,
    direction: 'out',
    sourceType: 'planned_event',
    sourceId: 1,
    sourceName: 'Test',
    accountId: null,
    ...partial,
  }
}

describe('deriveDipDrivers', () => {
  it('returns [] when there is no dip date', () => {
    expect(deriveDipDrivers([ev({})], null)).toEqual([])
  })

  it('includes only out occurrences on or before the dip date', () => {
    const drivers = deriveDipDrivers(
      [
        ev({ sourceName: 'Rent', date: '2026-07-01', amount: 1200 }),
        ev({ sourceName: 'Income', date: '2026-06-30', direction: 'in', amount: 5000 }),
        ev({ sourceName: 'After dip', date: '2026-07-05', amount: 999 }),
        ev({ sourceName: 'Transfer', date: '2026-06-29', direction: 'neutral', amount: 300 }),
      ],
      '2026-07-01',
    )
    expect(drivers.map((d) => d.sourceName)).toEqual(['Rent'])
  })

  it('sorts qualifying drivers by amount descending', () => {
    const drivers = deriveDipDrivers(
      [
        ev({ sourceName: 'Small', amount: 50 }),
        ev({ sourceName: 'Big', amount: 900 }),
        ev({ sourceName: 'Mid', amount: 300 }),
      ],
      '2026-07-01',
    )
    expect(drivers.map((d) => d.sourceName)).toEqual(['Big', 'Mid', 'Small'])
  })

  it('does not mutate the input array', () => {
    const input = [ev({ amount: 1 }), ev({ amount: 2 })]
    const snapshot = input.map((e) => e.amount)
    deriveDipDrivers(input, '2026-07-01')
    expect(input.map((e) => e.amount)).toEqual(snapshot)
  })
})

describe('driverLinkTarget', () => {
  it('links a planned_event to /planned?focus=<id>', () => {
    expect(driverLinkTarget('planned_event', 42)).toBe('/planned?focus=42')
  })

  it('links a recurring_detection to the detector list', () => {
    expect(driverLinkTarget('recurring_detection', 7)).toBe('/planned/recurring')
  })
})

describe('MAX_VISIBLE_DRIVERS', () => {
  it('caps the visible list at 8', () => {
    expect(MAX_VISIBLE_DRIVERS).toBe(8)
  })
})
