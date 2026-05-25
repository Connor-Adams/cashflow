import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor, act } from '@testing-library/react'
import { useCategories, _resetCategoriesCacheForTest } from './useCategories'
import * as api from './api'

describe('useCategories', () => {
  beforeEach(() => {
    _resetCategoriesCacheForTest()
    vi.restoreAllMocks()
  })

  it('fetches once and shares the result across hook instances', async () => {
    const spy = vi.spyOn(api, 'getJson').mockResolvedValue([
      { id: 1, householdId: 1, name: 'Coffee', icon: 'Coffee',
        createdAt: '', updatedAt: '' },
    ])
    const a = renderHook(() => useCategories())
    const b = renderHook(() => useCategories())
    await waitFor(() => expect(a.result.current.categories.length).toBe(1))
    await waitFor(() => expect(b.result.current.categories.length).toBe(1))
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('exposes refresh() that re-fetches', async () => {
    const spy = vi.spyOn(api, 'getJson').mockResolvedValue([])
    const { result } = renderHook(() => useCategories())
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1))
    await act(async () => { await result.current.refresh() })
    expect(spy).toHaveBeenCalledTimes(2)
  })

  it('byName(name) returns the matching category', async () => {
    vi.spyOn(api, 'getJson').mockResolvedValue([
      { id: 1, householdId: 1, name: 'Coffee', icon: 'Coffee',
        createdAt: '', updatedAt: '' },
      { id: 2, householdId: 1, name: 'Rent', icon: null,
        createdAt: '', updatedAt: '' },
    ])
    const { result } = renderHook(() => useCategories())
    await waitFor(() => expect(result.current.categories.length).toBe(2))
    expect(result.current.byName('Coffee')?.icon).toBe('Coffee')
    expect(result.current.byName('Rent')?.icon).toBeNull()
    expect(result.current.byName('Missing')).toBeUndefined()
    expect(result.current.byName(null)).toBeUndefined()
  })

  it('recovers after a failed fetch when refresh is called', async () => {
    const spy = vi
      .spyOn(api, 'getJson')
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce([
        { id: 1, householdId: 1, name: 'Coffee', icon: 'Coffee',
          createdAt: '', updatedAt: '' },
      ])
    const { result } = renderHook(() => useCategories())
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1))
    await act(async () => {
      await result.current.refresh().catch(() => {/* expected */})
    })
    await waitFor(() => expect(result.current.categories.length).toBe(1))
    expect(spy).toHaveBeenCalledTimes(2)
  })
})
