import React from 'react'
import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import { Table } from '../table'

describe('Table', () => {
  it('default: container has overflow-x-auto, no sticky classes, no inline maxHeight', () => {
    const { container } = render(<Table />)
    const tableContainer = container.querySelector('[data-slot="table-container"]') as HTMLElement
    expect(tableContainer).toBeTruthy()
    expect(tableContainer.className).toContain('overflow-x-auto')
    expect(tableContainer.className).not.toContain('overflow-auto')
    expect(tableContainer.style.maxHeight).toBe('')
    const table = container.querySelector('[data-slot="table"]') as HTMLElement
    expect(table.className).not.toContain('[&_thead_th]:sticky')
  })

  it('maxHeight + stickyHeader: container has overflow-auto + inline max-height, table has sticky-thead utilities', () => {
    const { container } = render(<Table maxHeight="72vh" stickyHeader />)
    const tableContainer = container.querySelector('[data-slot="table-container"]') as HTMLElement
    expect(tableContainer.className).toContain('overflow-auto')
    expect(tableContainer.className).not.toContain('overflow-x-auto')
    expect(tableContainer.style.maxHeight).toBe('72vh')
    const table = container.querySelector('[data-slot="table"]') as HTMLElement
    expect(table.className).toContain('[&_thead_th]:sticky')
    expect(table.className).toContain('[&_thead_th]:top-0')
    expect(table.className).toContain('[&_thead_th]:z-10')
    expect(table.className).toContain('[&_thead_th]:bg-card')
  })

  it('maxHeight only: container overflow-auto + inline maxHeight, no sticky on table', () => {
    const { container } = render(<Table maxHeight="50vh" />)
    const tableContainer = container.querySelector('[data-slot="table-container"]') as HTMLElement
    expect(tableContainer.className).toContain('overflow-auto')
    expect(tableContainer.style.maxHeight).toBe('50vh')
    const table = container.querySelector('[data-slot="table"]') as HTMLElement
    expect(table.className).not.toContain('[&_thead_th]:sticky')
  })

  it('stickyHeader only: table has sticky classes, container stays overflow-x-auto without maxHeight', () => {
    const { container } = render(<Table stickyHeader />)
    const tableContainer = container.querySelector('[data-slot="table-container"]') as HTMLElement
    expect(tableContainer.className).toContain('overflow-x-auto')
    expect(tableContainer.style.maxHeight).toBe('')
    const table = container.querySelector('[data-slot="table"]') as HTMLElement
    expect(table.className).toContain('[&_thead_th]:sticky')
  })

  it('does not spread maxHeight or stickyHeader onto the DOM table element', () => {
    const { container } = render(<Table maxHeight="72vh" stickyHeader />)
    const table = container.querySelector('[data-slot="table"]') as HTMLElement
    expect(table.hasAttribute('maxHeight')).toBe(false)
    expect(table.hasAttribute('stickyHeader')).toBe(false)
  })
})
