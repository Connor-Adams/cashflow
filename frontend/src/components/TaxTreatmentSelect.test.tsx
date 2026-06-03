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

  it('with emptyLabel, the empty option is selectable and fires onChange(null)', () => {
    const onChange = vi.fn();
    render(
      <TaxTreatmentSelect value={'salary'} options={['salary']} emptyLabel="Keep current" onChange={onChange} aria-label="t" />,
    );
    const select = screen.getByLabelText('t') as HTMLSelectElement;
    const empty = select.querySelector('option[value=""]') as HTMLOptionElement;
    expect(empty.disabled).toBe(false);
    expect(empty.textContent).toBe('Keep current');
    fireEvent.change(select, { target: { value: '' } });
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it('without emptyLabel, the placeholder option is disabled', () => {
    render(<TaxTreatmentSelect value={null} options={['salary']} onChange={vi.fn()} aria-label="t2" />);
    const empty = (screen.getByLabelText('t2') as HTMLSelectElement).querySelector('option[value=""]') as HTMLOptionElement;
    expect(empty.disabled).toBe(true);
  });
})
