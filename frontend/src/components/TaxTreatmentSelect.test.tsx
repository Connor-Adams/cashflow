import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { TaxTreatmentSelect } from './TaxTreatmentSelect'

describe('TaxTreatmentSelect', () => {
  it('renders only the scoped options + placeholder and fires onChange', () => {
    const onChange = vi.fn()
    render(
      <TaxTreatmentSelect
        value={null}
        options={['eligible_dividend', 'salary']}
        onChange={onChange}
        aria-label="treatment"
      />,
    )
    const select = screen.getByLabelText('treatment') as HTMLSelectElement
    expect(select.querySelectorAll('option')).toHaveLength(3) // placeholder + 2
    expect(screen.getByText('Eligible dividend')).toBeInTheDocument()
    expect(screen.getByText('Salary')).toBeInTheDocument()
    expect(screen.queryByText('Donation')).not.toBeInTheDocument()
    fireEvent.change(select, { target: { value: 'salary' } })
    expect(onChange).toHaveBeenCalledWith('salary')
  })
})
