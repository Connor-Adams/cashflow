import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import * as api from '@/lib/api'
import { useTaxSlips } from './useTaxSlips'

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return { ...actual, getJson: vi.fn() }
})

beforeEach(() => { vi.clearAllMocks() })

describe('useTaxSlips', () => {
  it('clears the previous year\'s error when the year changes', async () => {
    vi.mocked(api.getJson)
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ slips: [] })
    const { result, rerender } = renderHook(({ year }) => useTaxSlips(year), { initialProps: { year: 2024 } })
    await waitFor(() => expect(result.current.error).toBe('boom'))
    rerender({ year: 2025 })
    await waitFor(() => expect(api.getJson).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(result.current.error).toBeNull())
  })
})
