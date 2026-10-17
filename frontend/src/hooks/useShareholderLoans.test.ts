import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import * as api from '@/lib/api'
import { useShareholderLoans } from './useShareholderLoans'

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return { ...actual, getJson: vi.fn() }
})

beforeEach(() => { vi.clearAllMocks() })

describe('useShareholderLoans', () => {
  it('clears a stale error when a refresh succeeds', async () => {
    vi.mocked(api.getJson)
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ shareholderLoans: [], balance: '0.00' })
    const { result } = renderHook(() => useShareholderLoans())
    await waitFor(() => expect(result.current.error).toBe('boom'))
    await act(() => result.current.refresh())
    expect(result.current.error).toBeNull()
  })
})
