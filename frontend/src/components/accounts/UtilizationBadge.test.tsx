import React from 'react'
import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { UtilizationBadge } from './UtilizationBadge'

/**
 * Tier coverage for the badge (#437). Each tier maps to a distinct Tailwind
 * background class — assert the class is present, not the exact pixel colour.
 */
describe('UtilizationBadge', () => {
  it('renders nothing when utilization is null', () => {
    const { container } = render(<UtilizationBadge utilizationPct={null} />)
    expect(container.firstChild).toBeNull()
  })

  it('renders nothing when utilization is undefined', () => {
    const { container } = render(<UtilizationBadge utilizationPct={undefined} />)
    expect(container.firstChild).toBeNull()
  })

  it('renders nothing for NaN / Infinity', () => {
    const { container: c1 } = render(<UtilizationBadge utilizationPct={NaN} />)
    expect(c1.firstChild).toBeNull()
    const { container: c2 } = render(<UtilizationBadge utilizationPct={Infinity} />)
    expect(c2.firstChild).toBeNull()
  })

  it('low tier (0-30%): green background', () => {
    const { container } = render(<UtilizationBadge utilizationPct={25} />)
    expect(container.firstChild).toHaveTextContent('25% used')
    expect(container.firstChild).toHaveClass('bg-emerald-100')
  })

  it('medium tier (30-70%): amber background', () => {
    const { container } = render(<UtilizationBadge utilizationPct={50} />)
    expect(container.firstChild).toHaveTextContent('50% used')
    expect(container.firstChild).toHaveClass('bg-amber-100')
  })

  it('high tier (70-90%): orange background', () => {
    const { container } = render(<UtilizationBadge utilizationPct={85} />)
    expect(container.firstChild).toHaveTextContent('85% used')
    expect(container.firstChild).toHaveClass('bg-orange-100')
  })

  it('critical tier (90-100%): red background', () => {
    const { container } = render(<UtilizationBadge utilizationPct={95} />)
    expect(container.firstChild).toHaveTextContent('95% used')
    expect(container.firstChild).toHaveClass('bg-red-100')
  })

  it('over-limit (>100%): renders the ">100% — over limit" copy', () => {
    const { container } = render(<UtilizationBadge utilizationPct={150} />)
    expect(container.firstChild).toHaveTextContent('>100% — over limit')
    expect(container.firstChild).toHaveClass('bg-red-200')
    expect(container.firstChild).toHaveAttribute('title')
  })

  it('boundary at exactly 30% lands in the medium tier', () => {
    const { container } = render(<UtilizationBadge utilizationPct={30} />)
    expect(container.firstChild).toHaveClass('bg-amber-100')
  })

  it('boundary at exactly 70% lands in the high tier', () => {
    const { container } = render(<UtilizationBadge utilizationPct={70} />)
    expect(container.firstChild).toHaveClass('bg-orange-100')
  })

  it('boundary at exactly 90% lands in the critical tier', () => {
    const { container } = render(<UtilizationBadge utilizationPct={90} />)
    expect(container.firstChild).toHaveClass('bg-red-100')
  })

  it('boundary at exactly 100% stays critical (not over)', () => {
    const { container } = render(<UtilizationBadge utilizationPct={100} />)
    expect(container.firstChild).toHaveClass('bg-red-100')
    expect(container.firstChild).toHaveTextContent('100% used')
  })
})
