import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import * as api from '@/lib/api'
import { useInstalments } from './useInstalments'

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return { ...actual, getJson: vi.fn() }
})

beforeEach(() => { vi.clearAllMocks() })

describe('useInstalments', () => {
  it('clears the previous year\'s error when the year changes', async () => {
    vi.mocked(api.getJson)
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ instalments: [] })
    const { result, rerender } = renderHook(({ year }) => useInstalments(year), { initialProps: { year: 2024 } })
    await waitFor(() => expect(result.current.error).toBe('boom'))
    rerender({ year: 2025 })
    await waitFor(() => expect(api.getJson).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(result.current.error).toBeNull())
  })
})
