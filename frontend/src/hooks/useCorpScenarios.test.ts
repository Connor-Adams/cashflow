import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { useCorpScenarios } from './useCorpScenarios'
import * as api from '@/lib/api'

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return { ...actual, getJson: vi.fn() }
})

beforeEach(() => { vi.clearAllMocks() })

describe('useCorpScenarios', () => {
  it('never reports a previous year\'s list as loaded for the new year', async () => {
    vi.mocked(api.getJson).mockImplementation(async (path: string) => ({
      scenarios: [{ id: path.includes('2025') ? 25 : 26 }],
    }))
    const seen: { year: number; loading: boolean; ids: number[] }[] = []
    const { rerender, result } = renderHook(({ year }) => {
      const r = useCorpScenarios(1, year)
      seen.push({ year, loading: r.loading, ids: r.scenarios.map((s) => s.id) })
      return r
    }, { initialProps: { year: 2025 } })
    await waitFor(() => expect(result.current.loading).toBe(false))
    rerender({ year: 2026 })
    await waitFor(() => expect(result.current.scenarios.map((s) => s.id)).toEqual([26]))
    const stale = seen.filter((s) => s.year === 2026 && !s.loading && s.ids.includes(25))
    expect(stale).toEqual([])
  })
})
