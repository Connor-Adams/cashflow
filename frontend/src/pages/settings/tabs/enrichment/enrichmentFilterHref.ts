export function enrichmentFilterHref(param: string, value: string): string {
  const qs = new URLSearchParams({ [param]: value })
  return `/transactions?${qs.toString()}`
}
