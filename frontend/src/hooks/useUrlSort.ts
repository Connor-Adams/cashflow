import { useCallback } from 'react'
import { useSearchParams } from 'react-router-dom'

export type SortDir = 'asc' | 'desc'

export function useUrlSort<T extends string>(defaultField?: T) {
  const [searchParams, setSearchParams] = useSearchParams()
  const sort = (searchParams.get('sort') as T | null) ?? defaultField ?? null
  const dir = (searchParams.get('dir') as SortDir | null) ?? 'asc'

  const setSort = useCallback(
    (field: T) => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev)
          if (next.get('sort') === field) {
            // Toggle direction on re-click of same field.
            if (next.get('dir') === 'asc') {
              next.set('dir', 'desc')
            } else {
              // Third click resets sort.
              next.delete('sort')
              next.delete('dir')
            }
          } else {
            next.set('sort', field)
            next.set('dir', 'asc')
          }
          return next
        },
        { replace: true },
      )
    },
    [setSearchParams],
  )

  return { sort, dir, setSort }
}
