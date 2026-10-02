import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import * as api from '@/lib/api'
import { useTaxReturn } from './useTaxReturn'

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return { ...actual, getJson: vi.fn() }
})

beforeEach(() => { vi.clearAllMocks() })

describe('useTaxReturn', () => {
  it('clears the previous year\'s error when the year changes', async () => {
    vi.mocked(api.getJson)
      .mockRejectedValueOnce(new Error('no snapshot'))
      .mockResolvedValueOnce({ cached: true, computedAt: '', lines: [], totals: {}, warnings: [] })
    const { result, rerender } = renderHook(({ year }) => useTaxReturn(year), { initialProps: { year: 2024 } })
    await waitFor(() => expect(result.current.error).toBe('no snapshot'))
    rerender({ year: 2025 })
    await waitFor(() => expect(result.current.data).not.toBeNull())
    expect(result.current.error).toBeNull()
  })
})
