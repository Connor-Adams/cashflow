import React from 'react'
import { describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import { TableCard } from './table-card'
import type { TableColumn } from './table-card'
import {
  TableHeader, TableBody, TableRow, TableHead, TableCell } from '@connor-adams/designsystem'

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

  it('passes maxHeight through to the DS table-container scroll wrapper (default 72vh)', () => {
    const { container } = render(
      <TableCard title="Test">
        <TableHeader><TableRow><TableHead>A</TableHead></TableRow></TableHeader>
        <TableBody><TableRow><TableCell>1</TableCell></TableRow></TableBody>
      </TableCard>
    )
    // The DS Table renders its scroll wrapper as data-slot="table-container".
    // Since DS 0.3.0 the `overflow: auto` lives in the `.ca-table-container`
    // class; only maxHeight stays inline (so the passthrough is observable here).
    const tableContainer = container.querySelector('[data-slot="table-container"]') as HTMLElement
    expect(tableContainer).toHaveClass('ca-table-container')
    expect(tableContainer.style.maxHeight).toBe('72vh')
  })

  it('accepts a custom maxHeight', () => {
    const { container } = render(
      <TableCard title="Custom" maxHeight="50vh">
        <TableHeader><TableRow><TableHead>A</TableHead></TableRow></TableHeader>
        <TableBody><TableRow><TableCell>1</TableCell></TableRow></TableBody>
      </TableCard>
    )
    const tableContainer = container.querySelector('[data-slot="table-container"]') as HTMLElement
    expect(tableContainer.style.maxHeight).toBe('50vh')
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

type Person = { id: number; name: string; age: number }

const people: Person[] = [
  { id: 1, name: 'Charlie', age: 30 },
  { id: 2, name: 'Alice', age: 25 },
  { id: 3, name: 'Bob', age: 35 },
]

const columns: TableColumn<Person>[] = [
  { key: 'name', header: 'Name', sortable: true },
  {
    key: 'age',
    header: 'Age',
    sortable: true,
    render: (row) => `${row.age} yrs`,
  },
]

function bodyCellTexts(): string[] {
  // first cell (Name) of each body row, in DOM order
  const tbody = document.querySelector('[data-slot="table-body"]') as HTMLElement
  const rows = within(tbody).getAllByRole('row')
  return rows.map((r) => within(r).getAllByRole('cell')[0].textContent ?? '')
}

describe('TableCard data mode', () => {
  it('renders column headers and a cell from each row (render + default-accessor)', () => {
    render(<TableCard title="People" columns={columns} rows={people} />)
    expect(screen.getByRole('columnheader', { name: /Name/ })).toBeInTheDocument()
    expect(screen.getByRole('columnheader', { name: /Age/ })).toBeInTheDocument()
    // default-accessor render of name
    expect(screen.getByRole('cell', { name: 'Charlie' })).toBeInTheDocument()
    expect(screen.getByRole('cell', { name: 'Alice' })).toBeInTheDocument()
    // custom render of age
    expect(screen.getByRole('cell', { name: '30 yrs' })).toBeInTheDocument()
  })

  it('sortable header is a button and cycles asc -> desc -> default (tristate)', () => {
    render(<TableCard title="People" columns={columns} rows={people} />)

    // original order
    expect(bodyCellTexts()).toEqual(['Charlie', 'Alice', 'Bob'])

    const nameHeader = screen.getByRole('columnheader', { name: /Name/ })
    const nameButton = within(nameHeader).getByRole('button')
    expect(nameButton).toBeInTheDocument()
    expect(nameHeader).toHaveAttribute('aria-sort', 'none')

    // click 1 -> ascending
    fireEvent.click(nameButton)
    expect(nameHeader).toHaveAttribute('aria-sort', 'ascending')
    expect(bodyCellTexts()).toEqual(['Alice', 'Bob', 'Charlie'])

    // click 2 -> descending
    fireEvent.click(nameButton)
    expect(nameHeader).toHaveAttribute('aria-sort', 'descending')
    expect(bodyCellTexts()).toEqual(['Charlie', 'Bob', 'Alice'])

    // click 3 -> back to original / no sort
    fireEvent.click(nameButton)
    expect(nameHeader).toHaveAttribute('aria-sort', 'none')
    expect(bodyCellTexts()).toEqual(['Charlie', 'Alice', 'Bob'])
  })

  it('non-sortable column header is not a button and has no aria-sort', () => {
    const cols: TableColumn<Person>[] = [
      { key: 'name', header: 'Name', sortable: false },
      { key: 'age', header: 'Age', sortable: true },
    ]
    render(<TableCard title="People" columns={cols} rows={people} />)
    const nameHeader = screen.getByRole('columnheader', { name: 'Name' })
    expect(within(nameHeader).queryByRole('button')).toBeNull()
    expect(nameHeader).not.toHaveAttribute('aria-sort')
  })

  it('applies defaultSort on mount', () => {
    render(
      <TableCard
        title="People"
        columns={columns}
        rows={people}
        defaultSort={{ key: 'age', dir: 'asc' }}
      />
    )
    // sorted by age asc: Alice(25), Charlie(30), Bob(35)
    expect(bodyCellTexts()).toEqual(['Alice', 'Charlie', 'Bob'])
    const ageHeader = screen.getByRole('columnheader', { name: /Age/ })
    expect(ageHeader).toHaveAttribute('aria-sort', 'ascending')
  })

  it('reverts tristate to defaultSort (not null) when defaultSort is set', () => {
    render(
      <TableCard
        title="People"
        columns={columns}
        rows={people}
        defaultSort={{ key: 'name', dir: 'asc' }}
      />
    )
    const nameHeader = screen.getByRole('columnheader', { name: /Name/ })
    const nameButton = within(nameHeader).getByRole('button')
    // starts asc (default)
    expect(bodyCellTexts()).toEqual(['Alice', 'Bob', 'Charlie'])
    fireEvent.click(nameButton) // -> desc
    expect(bodyCellTexts()).toEqual(['Charlie', 'Bob', 'Alice'])
    fireEvent.click(nameButton) // -> revert to defaultSort (asc)
    expect(nameHeader).toHaveAttribute('aria-sort', 'ascending')
    expect(bodyCellTexts()).toEqual(['Alice', 'Bob', 'Charlie'])
  })

  it('calls onRowClick with the right row and index', () => {
    const onRowClick = vi.fn()
    render(
      <TableCard
        title="People"
        columns={columns}
        rows={people}
        onRowClick={onRowClick}
      />
    )
    const aliceCell = screen.getByRole('cell', { name: 'Alice' })
    fireEvent.click(aliceCell)
    expect(onRowClick).toHaveBeenCalledTimes(1)
    expect(onRowClick).toHaveBeenCalledWith(people[1], 1)
  })

  it('renders the empty node when rows is empty', () => {
    render(
      <TableCard
        title="People"
        columns={columns}
        rows={[]}
        empty="Nothing to see here"
      />
    )
    expect(screen.getByText('Nothing to see here')).toBeInTheDocument()
  })
})
