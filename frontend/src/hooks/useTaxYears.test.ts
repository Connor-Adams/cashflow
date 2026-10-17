import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import * as api from '@/lib/api'
import { useTaxYearCompare } from './useTaxYears'

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return { ...actual, getJson: vi.fn() }
})

beforeEach(() => { vi.clearAllMocks() })

describe('useTaxYearCompare', () => {
  it('clears the previous range\'s error when the range changes', async () => {
    vi.mocked(api.getJson)
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ years: [] })
    const { result, rerender } = renderHook(({ to }) => useTaxYearCompare(to - 2, to), { initialProps: { to: 2024 } })
    await waitFor(() => expect(result.current.error).toBe('boom'))
    rerender({ to: 2025 })
    await waitFor(() => expect(api.getJson).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.error).toBeNull()
  })
})
