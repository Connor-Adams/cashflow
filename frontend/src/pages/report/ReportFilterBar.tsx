import { Button } from '@/components/ui/button'
import { NativeSelect } from '@/components/ui/native-select'
import type { LifestyleScope } from '../../types/api'
import { WINDOW_OPTIONS, type ScopeOption } from './reportFilters'

export interface ReportFilterBarProps {
  /** Prefix for the control `id`s so two filter bars on a page stay unique. */
  idPrefix: string
  month: string
  onMonthChange: (month: string) => void
  months: number
  onMonthsChange: (months: number) => void
  scope: LifestyleScope
  onScopeChange: (scope: LifestyleScope) => void
  scopeOptions: ScopeOption[]
  currency: string
  onCurrencyChange: (currency: string) => void
  availableCurrencies: string[]
  loading: boolean
  onRefresh: () => void
}

/**
 * Month / window / scope / currency selector row + Refresh button shared by the
 * rolling-window report pages (SavingsRatePage, LifestyleInflationPage). Both
 * pages drive the identical backend filter contract, so the control row evolves
 * together. Page-specific controls (e.g. savings-rate's include-toggles) stay
 * on the page below this bar.
 */
export function ReportFilterBar({
  idPrefix,
  month,
  onMonthChange,
  months,
  onMonthsChange,
  scope,
  onScopeChange,
  scopeOptions,
  currency,
  onCurrencyChange,
  availableCurrencies,
  loading,
  onRefresh,
}: ReportFilterBarProps) {
  return (
    <div
      style={{
        display: 'flex',
        gap: 12,
        alignItems: 'flex-end',
        flexWrap: 'wrap',
      }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <label htmlFor={`${idPrefix}-month`}>Through month</label>
        <input
          id={`${idPrefix}-month`}
          type="month"
          value={month}
          onChange={(e) => onMonthChange(e.target.value)}
          className="input"
          style={{ minWidth: 160 }}
        />
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <label htmlFor={`${idPrefix}-window`}>Window</label>
        <NativeSelect
          id={`${idPrefix}-window`}
          value={String(months)}
          onChange={(e) => onMonthsChange(Number(e.target.value))}
        >
          {WINDOW_OPTIONS.map((w) => (
            <option key={w} value={w}>
              {w} months
            </option>
          ))}
        </NativeSelect>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <label htmlFor={`${idPrefix}-scope`}>Scope</label>
        <NativeSelect
          id={`${idPrefix}-scope`}
          value={scope}
          onChange={(e) => onScopeChange(e.target.value as LifestyleScope)}
        >
          {scopeOptions.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </NativeSelect>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <label htmlFor={`${idPrefix}-currency`}>Currency</label>
        <NativeSelect
          id={`${idPrefix}-currency`}
          value={currency}
          onChange={(e) => onCurrencyChange(e.target.value)}
        >
          <option value="">All currencies</option>
          {availableCurrencies.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </NativeSelect>
      </div>
      <Button
        type="button"
        variant="outline"
        onClick={onRefresh}
        disabled={loading}
      >
        Refresh
      </Button>
    </div>
  )
}
