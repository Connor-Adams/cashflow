import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ToastProvider } from '@/components/ui/toast'

void React

const create = vi.fn()

vi.mock('../../hooks/useTaxEntities', () => ({
  useTaxEntities: () => ({ entities: [{ id: 1, kind: 'personal' }], error: null }),
}))
vi.mock('../../hooks/useTaxSlips', () => ({
  useTaxSlips: () => ({ slips: [], error: null, create, refresh: vi.fn() }),
}))

import { SlipsTab } from './SlipsTab'

describe('SlipsTab submit', () => {
  it('tells the user when saving a slip fails and keeps what they typed', async () => {
    create.mockRejectedValue(new Error('server said no'))
    render(
      <ToastProvider>
        <SlipsTab year={2025} />
      </ToastProvider>,
    )
    const issuer = screen.getAllByRole('textbox')[0] as HTMLInputElement
    fireEvent.change(issuer, { target: { value: 'Acme Payroll' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add slip' }))
    expect(await screen.findByText('Failed to save slip')).toBeInTheDocument()
    expect(screen.getByText('server said no')).toBeInTheDocument()
    expect(issuer.value).toBe('Acme Payroll')
  })
})
