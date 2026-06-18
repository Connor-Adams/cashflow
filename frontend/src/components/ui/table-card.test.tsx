import React from 'react'
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { TableCard } from './table-card'
import {
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from './table'

describe('TableCard', () => {
  it('renders data-slot="table-card" on the Card wrapper', () => {
    const { container } = render(
      <TableCard>
        <TableHeader><TableRow><TableHead>A</TableHead></TableRow></TableHeader>
        <TableBody><TableRow><TableCell>1</TableCell></TableRow></TableBody>
      </TableCard>
    )
    const card = container.querySelector('[data-slot="table-card"]')
    expect(card).toBeTruthy()
  })

  it('renders an h2 with the title when title is provided', () => {
    render(
      <TableCard title="Holdings" actions={<span data-testid="badge">5</span>}>
        <TableHeader><TableRow><TableHead>A</TableHead></TableRow></TableHeader>
        <TableBody><TableRow><TableCell>1</TableCell></TableRow></TableBody>
      </TableCard>
    )
    expect(screen.getByRole('heading', { name: 'Holdings', level: 2 })).toBeInTheDocument()
  })

  it('renders actions content when title + actions provided', () => {
    render(
      <TableCard title="Holdings" actions={<span data-testid="badge">5</span>}>
        <TableHeader><TableRow><TableHead>A</TableHead></TableRow></TableHeader>
        <TableBody><TableRow><TableCell>1</TableCell></TableRow></TableBody>
      </TableCard>
    )
    expect(screen.getByTestId('badge')).toBeInTheDocument()
  })

  it('does NOT render an h2 when no title/description/actions', () => {
    render(
      <TableCard>
        <TableHeader><TableRow><TableHead>A</TableHead></TableRow></TableHeader>
        <TableBody><TableRow><TableCell>1</TableCell></TableRow></TableBody>
      </TableCard>
    )
    expect(screen.queryByRole('heading', { level: 2 })).toBeNull()
  })

  it('inner table container has overflow-auto and inline maxHeight (default 72vh)', () => {
    const { container } = render(
      <TableCard title="Test">
        <TableHeader><TableRow><TableHead>A</TableHead></TableRow></TableHeader>
        <TableBody><TableRow><TableCell>1</TableCell></TableRow></TableBody>
      </TableCard>
    )
    const tableContainer = container.querySelector('[data-slot="table-container"]') as HTMLElement
    expect(tableContainer.className).toContain('overflow-auto')
    expect(tableContainer.style.maxHeight).toBe('72vh')
  })

  it('inner table has sticky-thead utilities (stickyHeader defaults to true)', () => {
    const { container } = render(
      <TableCard title="Test">
        <TableHeader><TableRow><TableHead>A</TableHead></TableRow></TableHeader>
        <TableBody><TableRow><TableCell>1</TableCell></TableRow></TableBody>
      </TableCard>
    )
    const table = container.querySelector('[data-slot="table"]') as HTMLElement
    expect(table.className).toContain('[&_thead_th]:sticky')
    expect(table.className).toContain('[&_thead_th]:bg-card')
  })

  it('accepts custom maxHeight and stickyHeader=false', () => {
    const { container } = render(
      <TableCard title="Custom" maxHeight="50vh" stickyHeader={false}>
        <TableHeader><TableRow><TableHead>A</TableHead></TableRow></TableHeader>
        <TableBody><TableRow><TableCell>1</TableCell></TableRow></TableBody>
      </TableCard>
    )
    const tableContainer = container.querySelector('[data-slot="table-container"]') as HTMLElement
    expect(tableContainer.style.maxHeight).toBe('50vh')
    const table = container.querySelector('[data-slot="table"]') as HTMLElement
    expect(table.className).not.toContain('[&_thead_th]:sticky')
  })

  it('does not render SectionHeader (no h2) when only children provided (no title/description/actions)', () => {
    const { container } = render(
      <TableCard>
        <TableHeader><TableRow><TableHead>Col</TableHead></TableRow></TableHeader>
        <TableBody><TableRow><TableCell>val</TableCell></TableRow></TableBody>
      </TableCard>
    )
    expect(container.querySelector('[data-slot="section-header"]')).toBeNull()
  })
})
