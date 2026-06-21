import React from 'react'
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { EmptyTableRow } from './empty-table-row'

describe('EmptyTableRow', () => {
  it('renders a spanning cell with title + description', () => {
    render(
      <table>
        <tbody>
          <EmptyTableRow colSpan={3} title="None yet" description="Add one." />
        </tbody>
      </table>,
    )
    expect(screen.getByText('None yet')).toBeInTheDocument()
    expect(screen.getByText('Add one.')).toBeInTheDocument()
    expect(screen.getByRole('cell')).toHaveAttribute('colspan', '3')
  })
})
