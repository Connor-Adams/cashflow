import { useCallback, useEffect, useMemo, useState } from 'react'
import { getJson } from '../../lib/api'

/**
 * Shared response shape for the rolling-window report endpoints
 * (`/api/reports/savings-rate`, `/api/reports/lifestyle-inflation`). Both
 * return a per-currency breakdown plus the list of months in the window, which
 * is all this hook needs to drive the currency picker and the "Showing …"
 * window label.
 */
export interface RollingWindowReport {
  byCurrency: { currency: string }[]
  windowMonths: string[]
}

export interface ReportDataState<T> {
  data: T | null
  loading: boolean
  err: string | null
  reload: () => void
  /** Currencies present in the loaded data (plus the active filter), sorted. */
  availableCurrencies: string[]
  /** "first – last" month label for the loaded window, or '' when empty. */
  windowLabel: string
}

/**
 * Loads a rolling-window report from `path` and derives the currency picker
 * options + window label both report pages need. The active `currency` filter
 * is always kept in the options so the picker never collapses when a filter is
 * applied. Refetches whenever `path` changes; `reload()` forces a refetch.
 */
export function useReportData<T extends RollingWindowReport>(
  path: string,
  currency: string,
): ReportDataState<T> {
  const [data, setData] = useState<T | null>(null)
  const [loading, setLoading] = useState<boolean>(true)
  const [err, setErr] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setErr(null)
    try {
      const res = await getJson<T>(path)
      setData(res)
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Error')
    } finally {
      setLoading(false)
    }
  }, [path])

  useEffect(() => {
    void load()
  }, [load])

  const availableCurrencies = useMemo(() => {
    const set = new Set<string>()
    for (const c of data?.byCurrency ?? []) set.add(c.currency)
    if (currency) set.add(currency)
    return Array.from(set).sort()
  }, [data, currency])

  const windowLabel = useMemo(() => {
    const w = data?.windowMonths ?? []
    if (w.length === 0) return ''
    return `${w[0]} – ${w[w.length - 1]}`
  }, [data])

  return { data, loading, err, reload: load, availableCurrencies, windowLabel }
}
