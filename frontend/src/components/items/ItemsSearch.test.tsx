import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ItemsSearch } from './ItemsSearch'
import * as api from '@/lib/api'

void React

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return { ...actual, getJson: vi.fn() }
})

beforeEach(() => {
  vi.useFakeTimers()
  vi.mocked(api.getJson).mockResolvedValue({ items: [], nextCursor: null })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('ItemsSearch', () => {
  it('debounces input by 300ms', () => {
    const onChangeFilters = vi.fn()
    render(<ItemsSearch filters={{}} onChangeFilters={onChangeFilters} onOpenItem={() => {}} />)
    const input = screen.getByPlaceholderText(/search items/i)
    fireEvent.change(input, { target: { value: 'usb' } })
    onChangeFilters.mockClear()
    vi.advanceTimersByTime(299)
    expect(onChangeFilters).not.toHaveBeenCalled()
    vi.advanceTimersByTime(2)
    expect(onChangeFilters).toHaveBeenCalledWith(expect.objectContaining({ q: 'usb' }))
  })

  it('export opens CSV URL', () => {
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null)
    render(<ItemsSearch filters={{ vendor: 'amazon' }} onChangeFilters={() => {}} onOpenItem={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: /export csv/i }))
    expect(openSpy).toHaveBeenCalledWith(expect.stringContaining('format=csv'), '_blank')
    expect(openSpy).toHaveBeenCalledWith(expect.stringContaining('vendor=amazon'), '_blank')
  })
})
