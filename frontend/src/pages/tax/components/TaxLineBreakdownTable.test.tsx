/**
 * The T1 detail renders whatever lines the engine emits, in engine order. Pin
 * that the enhanced-CPP deduction (L22215) shows beside the other net-income
 * deductions with the same code/label/currency formatting — it is the one line
 * a hard-coded list would have missed.
 */
import React from 'react'
import { describe, it, expect } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import { TaxLineBreakdownTable, type TaxBreakdownLine } from './TaxLineBreakdownTable'

const line = (code: string, label: string, amount: string): TaxBreakdownLine =>
  ({ code, label, amount, inputs: [] })

describe('TaxLineBreakdownTable T1 deductions', () => {
  it('renders L22215 between L22200 and L23600, formatted like its neighbours', () => {
    render(
      <TaxLineBreakdownTable
        lines={[
          line('L20800', 'RRSP deduction', '5000.00'),
          line('L22200', 'CPP on self-employment (deductible half)', '1200.00'),
          line('L22215', 'Deduction for CPP enhanced contributions on employment income', '654.32'),
          line('L23600', 'Net income', '80000.00'),
        ]}
      />,
    )
    const rows = screen.getAllByRole('row').slice(1)
    expect(rows.map((r) => within(r).getAllByRole('cell')[0].textContent))
      .toEqual(['L20800', 'L22200', 'L22215', 'L23600'])
    const enhanced = rows[2]
    expect(within(enhanced).getByText(/CPP enhanced contributions/)).toBeInTheDocument()
    const neighbour = within(rows[1]).getAllByRole('cell')[2].textContent ?? ''
    const amount = within(enhanced).getAllByRole('cell')[2].textContent ?? ''
    expect(amount).toMatch(/654\.32/)
    // Same currency shape as the L22200 cell (symbol, grouping, two decimals).
    expect(amount.replace(/[\d,.]/g, '')).toBe(neighbour.replace(/[\d,.]/g, ''))
  })
})
