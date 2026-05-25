import React from 'react'
import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { Sparkline } from './sparkline'

describe('Sparkline', () => {
  it('renders null when data has fewer than 2 points', () => {
    const { container } = render(<Sparkline data={[{ date: '2026-05-01', value: 100 }]} />)
    expect(container.firstChild).toBeNull()
  })

  it('renders an SVG line when at least 2 points', () => {
    const { container } = render(
      <Sparkline data={[{ date: '2026-05-01', value: 100 }, { date: '2026-05-02', value: 102 }]} />,
    )
    expect(container.querySelector('svg')).not.toBeNull()
  })

  it('uses green stroke when trend is up', () => {
    const { container } = render(
      <Sparkline data={[{ date: 'a', value: 1 }, { date: 'b', value: 2 }]} />,
    )
    expect(container.innerHTML).toContain('--accent-positive')
  })

  it('uses warn stroke when trend is down', () => {
    const { container } = render(
      <Sparkline data={[{ date: 'a', value: 2 }, { date: 'b', value: 1 }]} />,
    )
    expect(container.innerHTML).toContain('--accent-warm')
  })
})
