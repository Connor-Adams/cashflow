import * as React from 'react'
import { Button } from '@cashflow/ui'
import { Input } from '@cashflow/ui'
import { Label } from '@cashflow/ui'
import { NativeSelect, NativeSelectOption } from '@cashflow/ui'
import { cn } from '@/lib/utils'

/**
 * Pre-computed quick range. Each filter consumer owns its own date math; the
 * FilterBar just renders a button per range and toggles `aria-pressed` when
 * `from`/`to` match the current selection. Strings are YYYY-MM-DD or '' for
 * "no bound" (used for the "All time" option).
 */
export type QuickRange = {
  key: string
  label: string
  from: string
  to: string
}

export type FilterBarProps = {
  /** Currency code (e.g. "CAD"). Empty string means "all currencies". */
  currency: string
  onCurrencyChange: (currency: string) => void
  /**
   * Options for the currency select. When provided the field is a
   * NativeSelect (with an "All currencies" option first when `allowAll`).
   * When omitted the field falls back to a free-text Input — useful for
   * pages that don't have a discovered currency list yet.
   */
  availableCurrencies?: string[]
  /** When using availableCurrencies, include a leading "All" option. */
  allowAllCurrencies?: boolean
  /** Label for the "all currencies" option (when allowAllCurrencies). */
  allCurrenciesLabel?: string

  /** YYYY-MM-DD or '' for none. */
  dateFrom: string
  dateTo: string
  onDateChange: (from: string, to: string) => void

  /** Quick-range buttons; each fires onDateChange when clicked. */
  quickRanges?: QuickRange[]
  /** Optional aria-label for the quick-range button group. */
  quickRangesLabel?: string

  /** Optional trailing slot in the inputs row (e.g. "Clear filters" button). */
  actions?: React.ReactNode

  /** Optional caption rendered below the controls (no margin). */
  caption?: React.ReactNode

  className?: string
}

function FilterBar({
  currency,
  onCurrencyChange,
  availableCurrencies,
  allowAllCurrencies = true,
  allCurrenciesLabel = 'All currencies',
  dateFrom,
  dateTo,
  onDateChange,
  quickRanges,
  quickRangesLabel = 'Quick date ranges',
  actions,
  caption,
  className,
}: FilterBarProps) {
  const activeQuickRangeKey = React.useMemo(() => {
    if (!quickRanges) return null
    return (
      quickRanges.find((range) => range.from === dateFrom && range.to === dateTo)
        ?.key ?? null
    )
  }, [quickRanges, dateFrom, dateTo])

  return (
    <div data-slot="filter-bar" className={cn('grid gap-3', className)}>
      <div className="row mb-0">
        <Label>
          Currency{' '}
          {availableCurrencies ? (
            <NativeSelect
              value={currency}
              onChange={(e) => onCurrencyChange(e.target.value)}
            >
              {allowAllCurrencies ? (
                <NativeSelectOption value="">{allCurrenciesLabel}</NativeSelectOption>
              ) : null}
              {availableCurrencies.map((c) => (
                <NativeSelectOption key={c} value={c}>
                  {c}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          ) : (
            <Input
              value={currency}
              onChange={(e) => onCurrencyChange(e.target.value.toUpperCase())}
              maxLength={3}
              placeholder="CAD"
              style={{ width: 90 }}
            />
          )}
        </Label>
        <Label>
          From{' '}
          <Input
            type="date"
            value={dateFrom}
            onChange={(e) => onDateChange(e.target.value, dateTo)}
          />
        </Label>
        <Label>
          To{' '}
          <Input
            type="date"
            value={dateTo}
            onChange={(e) => onDateChange(dateFrom, e.target.value)}
          />
        </Label>
        {actions}
      </div>
      {quickRanges && quickRanges.length > 0 ? (
        <div className="quickFilters" aria-label={quickRangesLabel}>
          {quickRanges.map((range) => {
            const pressed = activeQuickRangeKey === range.key
            return (
              <Button
                key={range.key}
                type="button"
                variant={pressed ? 'primary' : 'secondary'}
                size="sm"
                className="quickFilterButton"
                aria-pressed={pressed}
                onClick={(event) => {
                  event.currentTarget.blur()
                  onDateChange(range.from, range.to)
                }}
              >
                {range.label}
              </Button>
            )
          })}
        </div>
      ) : null}
      {caption}
    </div>
  )
}

export { FilterBar }
