import React from 'react'
import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import { HeroTile } from './HeroTile'

function renderHero(deltaCurrency: string) {
  return render(
    <HeroTile
      netSpendLabel={deltaCurrency ? '$120.00' : '2 currencies'}
      netSpendDelta={20}
      deltaCurrency={deltaCurrency}
      subMetrics={[
        { label: 'Spend', value: '$100.00', delta: 12, metricKind: 'spend' },
        { label: 'Income', value: '$50.00', delta: -8, metricKind: 'gain' },
      ]}
      comparisonHint="2026-05-01 to 2026-05-31"
      moneyHint="In CAD"
      sparklineData={[]}
    />,
  )
}

describe('HeroTile delta badges', () => {
  it('renders currency-formatted delta badges for a single-currency view', () => {
    const { container } = renderHero('CAD')
    const badges = container.querySelectorAll('[data-slot="delta-badge"]')
    // netSpendDelta + the two sub-metric deltas
    expect(badges).toHaveLength(3)
  })

  it('suppresses delta badges when deltaCurrency is empty (multi-currency aggregation)', () => {
    // An empty deltaCurrency means the page summed raw amounts across
    // currencies (the "All currencies" dashboard view). Those deltas are not
    // a number in any currency, so no badge may render — matching how the
    // headline labels degrade to "N currencies".
    const { container } = renderHero('')
    expect(container.querySelectorAll('[data-slot="delta-badge"]')).toHaveLength(0)
  })
})
