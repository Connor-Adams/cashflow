import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor, act } from '@testing-library/react'
import { useItemsQuery, type ItemsFilters } from './useItems'
import * as api from '@/lib/api'

void React

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return { ...actual, getJson: vi.fn() }
})

const baseFilters: ItemsFilters = {}

function sampleRow(id: number, title = 'x') {
  return {
    id,
    title,
    qty: 1,
    unitPrice: 1,
    totalPrice: 1,
    taxShare: 0,
    categoryEffective: null,
    categoryOverride: null,
    businessUseEffective: false,
    businessUseOverride: null,
    order: { id, vendor: 'v' },
    receipt: { id, date: '2026-05-01', sourceTxnId: id },
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('useItemsQuery', () => {
  it('returns loading then data on success', async () => {
    vi.mocked(api.getJson).mockResolvedValue({ items: [sampleRow(1, 'a')], nextCursor: null })
    const { result } = renderHook(() => useItemsQuery(baseFilters))
    expect(result.current.loading).toBe(true)
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.items).toHaveLength(1)
    expect(result.current.error).toBe(null)
  })

  it('sets error state on failure', async () => {
    vi.mocked(api.getJson).mockRejectedValue(new Error('boom'))
    const { result } = renderHook(() => useItemsQuery(baseFilters))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.error).toBeTruthy()
    expect(result.current.items).toEqual([])
  })

  it('discards stale response when filters change mid-flight', async () => {
    let resolveFirst: ((v: unknown) => void) | null = null
    vi.mocked(api.getJson)
      .mockImplementationOnce(
        () =>
          new Promise((r) => {
            resolveFirst = r as (v: unknown) => void
          }),
      )
      .mockResolvedValueOnce({ items: [sampleRow(2, 'second')], nextCursor: null })

    const { result, rerender } = renderHook(({ f }) => useItemsQuery(f), {
      initialProps: { f: { category: 'X' } as ItemsFilters },
    })
    rerender({ f: { category: 'Y' } as ItemsFilters })
    if (resolveFirst) {
      ;(resolveFirst as (v: unknown) => void)({ items: [sampleRow(99, 'stale')], nextCursor: null })
    }
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.items).toHaveLength(1)
    expect(result.current.items[0].id).toBe(2)
  })

  it('fetchMore appends rows and advances cursor', async () => {
    vi.mocked(api.getJson)
      .mockResolvedValueOnce({ items: [sampleRow(1, 'a')], nextCursor: 'CURSOR1' })
      .mockResolvedValueOnce({ items: [sampleRow(2, 'b')], nextCursor: null })
    const { result } = renderHook(() => useItemsQuery(baseFilters))
    await waitFor(() => expect(result.current.loading).toBe(false))
    await act(async () => {
      await result.current.fetchMore()
    })
    await waitFor(() => expect(result.current.items).toHaveLength(2))
    expect(result.current.nextCursor).toBe(null)
  })
})
