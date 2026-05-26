import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { BenchmarkPickerCard } from './BenchmarkPickerCard'
import * as api from '../../lib/api'

describe('BenchmarkPickerCard', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('shows current symbol', () => {
    render(<BenchmarkPickerCard currentSymbol="SPY" onChange={() => {}} />)
    expect(screen.getByText(/SPY/)).toBeInTheDocument()
  })

  it('save fires PATCH and onChange', async () => {
    const fetchSpy = vi.spyOn(api, 'patchJson').mockResolvedValue({ benchmarkSymbol: 'VEQT.TO' })
    const onChange = vi.fn()
    render(<BenchmarkPickerCard currentSymbol="SPY" onChange={onChange} />)
    fireEvent.click(screen.getByRole('button', { name: /change/i }))
    fireEvent.change(screen.getByLabelText(/symbol/i), { target: { value: 'VEQT.TO' } })
    fireEvent.click(screen.getByRole('button', { name: /save/i }))
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledWith('/api/household/benchmark', { benchmarkSymbol: 'VEQT.TO' }))
    await waitFor(() => expect(onChange).toHaveBeenCalledWith('VEQT.TO'))
  })
})
