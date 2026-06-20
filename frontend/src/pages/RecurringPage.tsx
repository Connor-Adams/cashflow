import { useEffect, useMemo, useState } from 'react'
import { Badge } from '@connor-adams/designsystem'
import { CollapsibleCard } from '@/components/ui/collapsible-card'
import { EmptyTableRow } from '@/lib/ds-extras'
import { FilterBar } from '@/components/ui/filter-bar'
import { FilterCard } from '@/components/ui/filter-card'
import { PageHeader } from '@/components/ui/page-header'
import { SkeletonRow } from '@/lib/ds-extras'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@connor-adams/designsystem'
import { SortableTableHead } from '@/components/table/SortableTableHead'
import { getJson } from '../lib/api'
import { formatMoney } from '../lib/formatMoney'
import { useSessionState } from '../lib/useSessionState'
import { useUrlSort } from '../hooks/useUrlSort'
import type { RecurringResponse } from '../types/api'

const RECURRING_SORT_FIELDS = ['merchant', 'amount', 'cadence', 'nextOccurrence', 'lastSeenAt'] as const

const DEFAULT_CURRENCY = 'CAD'
const COLUMN_COUNT = 7

export function RecurringPage() {
  const [currency, setCurrency] = useSessionState('recurring.currency', DEFAULT_CURRENCY)
  const [data, setData] = useState<RecurringResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const { sort, dir, toggle } = useUrlSort(RECURRING_SORT_FIELDS)

  const queryString = useMemo(() => {
    const params = new URLSearchParams()
    const c = currency.trim()
    if (c) params.set('currency', c.toUpperCase().slice(0, 3))
    if (sort) { params.set('sort', sort); params.set('dir', dir) }
    const s = params.toString()
    return s ? `?${s}` : ''
  }, [currency, sort, dir])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      setLoading(true)
      setErr(null)
      try {
        const next = await getJson<RecurringResponse>(`/api/recurring${queryString}`)
        if (!cancelled) setData(next)
      } catch (e) {
        if (!cancelled) setErr(e instanceof Error ? e.message : 'Error')
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [queryString])

  const availableCurrencies = useMemo(() => {
    const found = new Set<string>()
    data?.items.forEach((item) => found.add(item.currency))
    found.add(DEFAULT_CURRENCY)
    if (currency) found.add(currency)
    return Array.from(found).sort()
  }, [data, currency])

  const visibleItems = data?.items ?? []
  const windowDays = data?.windowDays ?? 180
  const minOccurrences = data?.minOccurrences ?? 3

  return (
    <div className="page">
      <PageHeader
        title="Recurring"
        description={`Merchants you spend with on a regular cadence — looking back ${windowDays} days, with at least ${minOccurrences} charges to qualify.`}
      />

      <FilterCard>
        <FilterBar
          currency={currency}
          onCurrencyChange={setCurrency}
          availableCurrencies={availableCurrencies}
          dateFrom=""
          dateTo=""
          onDateChange={() => {
            /* date filtering for recurring is driven by windowDays server-side */
          }}
        />
      </FilterCard>

      {err && <p className="error" role="alert">{err}</p>}

      <CollapsibleCard
        id="recurring-merchants"
        title="Recurring merchants"
        description={`Detected charges that repeat within the last ${windowDays} days.`}
      >
        <div className="tableWrap" aria-busy={loading}>
          <Table className="table">
            <TableHeader>
              <TableRow>
                <SortableTableHead field="merchant" label="Merchant" currentSort={sort} dir={dir} onSort={toggle} />
                <SortableTableHead field="cadence" label="Cadence" currentSort={sort} dir={dir} onSort={toggle} />
                <SortableTableHead field="amount" label="Avg amount" currentSort={sort} dir={dir} onSort={toggle} />
                <TableHead>Stability</TableHead>
                <SortableTableHead field="lastSeenAt" label="Last seen" currentSort={sort} dir={dir} onSort={toggle} />
                <SortableTableHead field="nextOccurrence" label="Next expected" currentSort={sort} dir={dir} onSort={toggle} />
                <TableHead>Category</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading ? (
                Array.from({ length: 6 }).map((_, i) => (
                  <SkeletonRow key={`recurring-skeleton-${i}`} cols={COLUMN_COUNT} />
                ))
              ) : visibleItems.length === 0 ? (
                <EmptyTableRow
                  colSpan={COLUMN_COUNT}
                  title="No recurring merchants detected yet."
                  description="Try widening the currency filter, or import more history so the detector has enough data to spot a pattern."
                />
              ) : (
                visibleItems.map((item) => (
                  <TableRow key={`${item.merchant}-${item.currency}`}>
                    <TableCell>{item.merchant}</TableCell>
                    <TableCell>
                      <Badge variant={item.cadence === 'monthly' ? 'default' : 'secondary'}>
                        {item.cadence}
                      </Badge>
                    </TableCell>
                    <TableCell>{formatMoney(item.avgAmount, item.currency)}</TableCell>
                    <TableCell>{Math.round(item.amountStability * 100)}%</TableCell>
                    <TableCell>{item.lastSeen}</TableCell>
                    <TableCell>{item.nextExpected}</TableCell>
                    <TableCell>{item.category ?? '—'}</TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </CollapsibleCard>
    </div>
  )
}
