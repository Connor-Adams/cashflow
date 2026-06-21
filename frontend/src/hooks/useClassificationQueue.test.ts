import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { useClassificationQueue } from './useClassificationQueue'
import * as api from '@/lib/api'

void React

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return { ...actual, getJson: vi.fn() }
})

beforeEach(() => { vi.clearAllMocks() })

describe('useClassificationQueue', () => {
  it('requests the classified queue when status=classified', async () => {
    vi.mocked(api.getJson).mockResolvedValue({ corpDistributions: [], payroll: [] })
    const { result } = renderHook(() => useClassificationQueue(5, 2025, 'classified'))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(api.getJson).toHaveBeenCalledWith(
      '/api/tax/classification-queue?entityId=5&year=2025&status=classified',
    )
  })

  it('defaults to the unclassified queue', async () => {
    vi.mocked(api.getJson).mockResolvedValue({ corpDistributions: [], payroll: [] })
    const { result } = renderHook(() => useClassificationQueue(5, 2025))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(api.getJson).toHaveBeenCalledWith(
      '/api/tax/classification-queue?entityId=5&year=2025&status=unclassified',
    )
  })
})
