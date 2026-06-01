import { useCallback } from 'react'
import { useSearchParams } from 'react-router-dom'

export type SortDir = 'asc' | 'desc'

export function useUrlSort(validFields: readonly string[]) {
  const [params, setParams] = useSearchParams()
  const sortRaw = params.get('sort')
  const dirRaw = params.get('dir')
  const sort: string | null = sortRaw && validFields.includes(sortRaw) ? sortRaw : null
  const dir: SortDir = dirRaw === 'asc' || dirRaw === 'desc' ? dirRaw : 'asc'

  const toggle = useCallback(
    (field: string) => {
      const p = new URLSearchParams(params)
      if (sort === field) {
        if (dir === 'asc') {
          p.set('sort', field)
          p.set('dir', 'desc')
        } else {
          p.delete('sort')
          p.delete('dir')
        }
      } else {
        p.set('sort', field)
        p.set('dir', 'asc')
      }
      setParams(p, { replace: true })
    },
    [sort, dir, params, setParams],
  )

  return { sort, dir, toggle }
}
