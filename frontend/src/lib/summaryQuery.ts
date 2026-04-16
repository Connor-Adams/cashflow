/** Build query string for `/api/summary/*` routes (currency + date range). */
export function summaryQueryString(opts: {
  currency?: string
  dateFrom?: string
  dateTo?: string
}): string {
  const params = new URLSearchParams()
  const c = opts.currency?.trim()
  if (c) params.set('currency', c.toUpperCase().slice(0, 3))
  const df = opts.dateFrom?.trim()
  if (df) params.set('dateFrom', df)
  const dt = opts.dateTo?.trim()
  if (dt) params.set('dateTo', dt)
  const s = params.toString()
  return s ? `?${s}` : ''
}
