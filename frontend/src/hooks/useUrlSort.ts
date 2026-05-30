import { useCallback } from 'react'
import { useSearchParams } from 'react-router-dom'

export type SortDir = 'asc' | 'desc'

export type UseUrlSortResult = {
  sort: string | null
  dir: SortDir | null
  setSort: (field: string, dir: SortDir) => void
  clearSort: () => void
}

/**
 * Reads ?sort=<field>&dir=asc|desc from the URL search params and returns
 * helpers that update those params without losing other params in the URL.
 */
export function useUrlSort(): UseUrlSortResult {
  const [searchParams, setSearchParams] = useSearchParams()

  const sort = searchParams.get('sort') ?? null
  const rawDir = searchParams.get('dir')
  const dir: SortDir | null =
    rawDir === 'asc' || rawDir === 'desc' ? rawDir : null

  const setSort = useCallback(
    (field: string, direction: SortDir) => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev)
          next.set('sort', field)
          next.set('dir', direction)
          return next
        },
        { replace: true },
      )
    },
    [setSearchParams],
  )

  const clearSort = useCallback(() => {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev)
        next.delete('sort')
        next.delete('dir')
        return next
      },
      { replace: true },
    )
  }, [setSearchParams])

  return { sort, dir, setSort, clearSort }
}
