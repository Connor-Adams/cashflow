/**
 * Tests for the shared SankeyChart — the chart extracted out of SankeyPage so
 * the Dashboard can render the same picture (2026-09-27 full-chain spec).
 *
 * The component owns only the chart and its custom node / link renderers; it
 * takes data + currency as props and grows no controls of its own. Recharts is
 * mocked so the render props can be exercised without SVG layout math.
 */
import React from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

vi.mock('recharts', () => {
  type LinkPayload = {
    source: number | { index?: number; name?: string }
    target: number | { index?: number; name?: string }
    value: number
  }
  return {
    ResponsiveContainer: ({ children }: { children: React.ReactNode }) => (
      <div data-testid="responsive">{children}</div>
    ),
    Sankey: ({ data, link, node, children }: {
      data: { nodes: Array<{ name: string }>; links: LinkPayload[] }
      link: (props: unknown) => React.ReactElement
      node: (props: unknown) => React.ReactElement
      children?: React.ReactNode
    }) => (
      <div data-testid="sankey">
        {data.links.map((l, idx) => (
          <div key={idx}>
            {link({
              payload: l,
              sourceX: 0,
              sourceY: 0,
              targetX: 0,
              targetY: 0,
              sourceControlX: 0,
              targetControlX: 0,
              linkWidth: 8,
              index: idx,
            })}
          </div>
        ))}
        {data.nodes.map((n, idx) => (
          <div key={idx}>
            {node({ payload: n, index: idx, x: 0, y: 0, width: 10, height: 20 })}
          </div>
        ))}
        {children}
      </div>
    ),
    Rectangle: (props: React.SVGProps<SVGRectElement>) => <rect {...props} />,
    Tooltip: () => null,
  }
})

import { SankeyChart } from './SankeyChart'
import type { SankeyResponse } from '../types/api'

const DATA: SankeyResponse = {
  currency: 'CAD',
  totalIncome: 5000,
  totalSpend: 425,
  surplus: 4575,
  balanced: true,
  transactionCount: 4,
  nodes: [
    { name: 'Income', kind: 'income' },
    { name: 'Owner draws', kind: 'draws' },
    { name: 'Groceries', kind: 'category' },
    { name: 'Surplus', kind: 'surplus' },
  ],
  links: [
    { source: 0, target: 1, value: 425 },
    { source: 1, target: 2, value: 425 },
    { source: 0, target: 3, value: 4575 },
  ],
  availableCurrencies: ['CAD', 'USD'],
  dateRange: { from: null, to: null },
}

describe('SankeyChart', () => {
  it('labels every node in the payload, at every depth', () => {
    render(<SankeyChart data={DATA} currency="CAD" />)
    for (const name of ['Income', 'Owner draws', 'Groceries', 'Surplus']) {
      expect(screen.getByText(name)).toBeInTheDocument()
    }
  })

  it('draws one link path per link', () => {
    render(<SankeyChart data={DATA} currency="CAD" />)
    expect(screen.getAllByTestId('sankey-link')).toHaveLength(3)
  })

  it('reports the clicked edge by node index when onLinkClick is given', async () => {
    const user = userEvent.setup()
    const onLinkClick = vi.fn()
    render(<SankeyChart data={DATA} currency="CAD" onLinkClick={onLinkClick} />)
    await user.click(screen.getAllByTestId('sankey-link')[1])
    expect(onLinkClick).toHaveBeenCalledWith(1, 2)
  })

  it('renders inert links when no onLinkClick is given (the dashboard embed)', async () => {
    const user = userEvent.setup()
    render(<SankeyChart data={DATA} currency="CAD" />)
    const link = screen.getAllByTestId('sankey-link')[0]
    expect(link).not.toHaveAttribute('role', 'button')
    // Clicking must not throw when the consumer opted out of drill-down.
    await user.click(link)
  })

  it('grows no controls of its own — the consumer owns currency and range', () => {
    render(<SankeyChart data={DATA} currency="CAD" />)
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  it('renders nothing when the payload has no nodes', () => {
    const { container } = render(
      <SankeyChart data={{ ...DATA, nodes: [], links: [] }} currency="CAD" />,
    )
    expect(container).toBeEmptyDOMElement()
  })

  // The "does every colour token this chart names actually resolve?" guard
  // used to live here, reading only @connor-adams/tokens. It is superseded by
  // `src/styles/theme.test.ts`, which scans every `var(--chart-…)` call site
  // under src/ and accepts a name defined in either the DS ramp or the
  // app-owned aliases in theme.css — the seam this chart's per-domain names
  // (--chart-income, --chart-draws, --chart-surplus, …) live on.

  it('honours the height prop so the dashboard embed can be shorter', () => {
    const { container } = render(
      <SankeyChart data={DATA} currency="CAD" height={280} />,
    )
    const frame = container.querySelector('[data-slot="sankey-chart"]')
    expect(frame).toHaveStyle({ height: '280px' })
  })
})
