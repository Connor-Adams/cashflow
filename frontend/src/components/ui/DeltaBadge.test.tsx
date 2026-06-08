import React from 'react'
import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { DeltaBadge } from './DeltaBadge'

describe('DeltaBadge', () => {
  it('renders positive spend delta as negative tone (up is bad)', () => {
    const { container } = render(
      <DeltaBadge delta={100} metricKind="spend" currency="CAD" />
    )
    const badge = container.querySelector('[data-slot="delta-badge"]')!
    expect(badge.getAttribute('data-sign')).toBe('positive')
    expect(badge.getAttribute('data-tone')).toBe('negative')
    expect(badge.textContent).toContain('▲')
  })

  it('renders negative gain delta as negative tone (down is bad)', () => {
    const { container } = render(
      <DeltaBadge delta={-50} metricKind="gain" currency="CAD" />
    )
    const badge = container.querySelector('[data-slot="delta-badge"]')!
    expect(badge.getAttribute('data-sign')).toBe('negative')
    expect(badge.getAttribute('data-tone')).toBe('negative')
    expect(badge.textContent).toContain('▼')
  })

  it('renders zero delta as neutral', () => {
    const { container } = render(
      <DeltaBadge delta={0} metricKind="spend" currency="CAD" />
    )
    const badge = container.querySelector('[data-slot="delta-badge"]')!
    expect(badge.getAttribute('data-tone')).toBe('neutral')
    expect(badge.textContent).toContain('—')
  })

  it('formats without currency symbol when currency is omitted', () => {
    const { container } = render(
      <DeltaBadge delta={5} metricKind="neutral" />
    )
    const badge = container.querySelector('[data-slot="delta-badge"]')!
    expect(badge.textContent).toContain('5')
    expect(badge.textContent).not.toContain('$')
  })

  it('renders neutral metricKind with neutral tone regardless of sign', () => {
    const { container } = render(
      <DeltaBadge delta={100} metricKind="neutral" currency="CAD" />
    )
    const badge = container.querySelector('[data-slot="delta-badge"]')!
    expect(badge.getAttribute('data-tone')).toBe('neutral')
  })

  it('uses absolute value for formatted amount', () => {
    const { container } = render(
      <DeltaBadge delta={-75.5} metricKind="spend" currency="CAD" />
    )
    const badge = container.querySelector('[data-slot="delta-badge"]')!
    expect(badge.textContent).toContain('75.50')
    expect(badge.textContent).not.toContain('-')
  })
})
