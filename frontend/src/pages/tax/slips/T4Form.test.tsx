/**
 * The engine reads T4 box 16A (CPP2, second additional contributions) as its
 * own line. Without a field for it, a slip entered here can never carry CPP2,
 * so the T1 would treat a high earner's CPP2 as if it were never withheld.
 */
import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { T4Form } from './T4Form'

describe('T4Form box 16A', () => {
  it('offers a box 16A (CPP2) field', () => {
    render(<T4Form issuer="Employer" values={{}} onChange={vi.fn()} />)
    expect(screen.getByLabelText(/Box 16A —.*CPP2/)).toBeInTheDocument()
  })

  it('writes box 16A under the key the engine reads, as a number', () => {
    const onChange = vi.fn()
    render(<T4Form issuer="Employer" values={{ box16: 4000 }} onChange={onChange} />)
    fireEvent.change(screen.getByLabelText(/Box 16A —/), { target: { value: '416' } })
    expect(onChange).toHaveBeenCalledWith('Employer', { box16: 4000, box16A: 416 })
  })

  it('drops box 16A when cleared, like the other boxes', () => {
    const onChange = vi.fn()
    render(<T4Form issuer="Employer" values={{ box16: 4000, box16A: 416 }} onChange={onChange} />)
    fireEvent.change(screen.getByLabelText(/Box 16A —/), { target: { value: '' } })
    expect(onChange).toHaveBeenCalledWith('Employer', { box16: 4000 })
  })
})
