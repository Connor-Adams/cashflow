import React from 'react'
import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { StatCard, resolveDeltaTone } from '@connor-adams/designsystem'

// Guards the issue #929 consolidation: app code now renders the DS StatCard
// directly (no app-local stat-card.tsx). These tests pin the money-semantics
// delta tone so a future DS bump that flips the sign logic fails loudly here.
describe('DS StatCard adoption (issue #929)', () => {
  it('renders label, value, and hint', () => {
    const html = renderToStaticMarkup(
      <StatCard label="Unreviewed" value="6" hint="Open transactions" />
    )
    expect(html).toContain('Unreviewed')
    expect(html).toContain('6')
    expect(html).toContain('Open transactions')
  })

  it('colors a gain "up" delta green (positive tone)', () => {
    const html = renderToStaticMarkup(
      <StatCard label="Refunds" value="$10" delta="+5" metricKind="gain" />
    )
    expect(html).toContain('data-slot="stat-card-delta"')
    expect(html).toContain('data-tone="positive"')
    expect(html).toContain('+5')
  })

  it('colors a gain "down" delta red (negative tone)', () => {
    const html = renderToStaticMarkup(
      <StatCard label="Refunds" value="$10" delta="-5" metricKind="gain" />
    )
    expect(html).toContain('data-tone="negative"')
  })

  it('colors a spend "up" delta red (inverted → negative tone)', () => {
    const html = renderToStaticMarkup(
      <StatCard label="Spend" value="$100" delta="+12.34" metricKind="spend" />
    )
    expect(html).toContain('data-tone="negative"')
    expect(html).toContain('+12.34')
  })

  it('colors a spend "down" delta green (inverted → positive tone)', () => {
    const html = renderToStaticMarkup(
      <StatCard label="Spend" value="$100" delta="-7" metricKind="spend" />
    )
    expect(html).toContain('data-tone="positive"')
  })

  it('keeps a neutral metric muted regardless of sign', () => {
    const up = renderToStaticMarkup(
      <StatCard label="Transactions" value="42" delta="+3" metricKind="neutral" />
    )
    expect(up).toContain('data-tone="neutral"')

    const down = renderToStaticMarkup(
      <StatCard label="Transactions" value="42" delta="-3" metricKind="neutral" />
    )
    expect(down).toContain('data-tone="neutral"')
  })

  it('defaults metricKind to gain (up is good) when omitted', () => {
    const html = renderToStaticMarkup(
      <StatCard label="Refunds" value="$10" delta="+5" />
    )
    expect(html).toContain('data-tone="positive"')
  })

  // resolveDeltaTone is the shared money-semantics core both StatCard and the
  // app's DeltaBadge wrapper lean on; assert it directly so the contract is
  // pinned independent of any one consumer.
  describe('resolveDeltaTone', () => {
    it('gain: sign passes through', () => {
      expect(resolveDeltaTone('positive', 'gain')).toBe('positive')
      expect(resolveDeltaTone('negative', 'gain')).toBe('negative')
    })

    it('spend: sign inverts', () => {
      expect(resolveDeltaTone('positive', 'spend')).toBe('negative')
      expect(resolveDeltaTone('negative', 'spend')).toBe('positive')
    })

    it('neutral kind or neutral sign → neutral', () => {
      expect(resolveDeltaTone('positive', 'neutral')).toBe('neutral')
      expect(resolveDeltaTone('neutral', 'gain')).toBe('neutral')
    })
  })
})
