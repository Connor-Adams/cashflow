/**
 * T3 box labels must match CRA, or the engine fix makes things worse rather than
 * better: it now reads box 50 as the taxable eligible amount, so a form that asks
 * for the dividend tax credit there would wire a credit into an income line.
 *
 * CRA T3: box 21 capital gains, box 23 actual non-eligible, box 26 other income,
 * box 32 TAXABLE non-eligible, box 49 ACTUAL eligible, box 50 TAXABLE eligible,
 * box 51 the eligible dividend tax credit.
 */
import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { T3Form } from './T3Form'

describe('T3Form box labels', () => {
  it('labels box 32 as the taxable non-eligible amount', () => {
    render(<T3Form issuer="Trust" values={{}} onChange={vi.fn()} />)
    expect(screen.getByText(/Box 32 —.*non-eligible/i)).toBeInTheDocument()
  })

  it('labels box 49 as the actual eligible amount and box 50 as the taxable one', () => {
    render(<T3Form issuer="Trust" values={{}} onChange={vi.fn()} />)
    expect(screen.getByText(/Box 49 —.*[Aa]ctual.*eligible/)).toBeInTheDocument()
    expect(screen.getByText(/Box 50 —.*[Tt]axable.*eligible/)).toBeInTheDocument()
  })

  it('does not label box 50 as a tax credit', () => {
    render(<T3Form issuer="Trust" values={{}} onChange={vi.fn()} />)
    expect(screen.queryByText(/Box 50 —.*credit/i)).not.toBeInTheDocument()
  })
})
