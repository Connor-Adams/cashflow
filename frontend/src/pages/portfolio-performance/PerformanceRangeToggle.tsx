import type { PortfolioPerformanceRange } from '../../types/api'

export type PerformanceRangeToggleProps = {
  value: PortfolioPerformanceRange
  onChange: (next: PortfolioPerformanceRange) => void
}

const OPTIONS: Array<{ label: string; value: PortfolioPerformanceRange }> = [
  { label: '1M', value: '1M' },
  { label: '3M', value: '3M' },
  { label: 'YTD', value: 'YTD' },
  { label: '1Y', value: '1Y' },
  { label: 'All', value: 'All' },
  { label: 'Custom', value: 'custom' },
]

export function PerformanceRangeToggle({ value, onChange }: PerformanceRangeToggleProps) {
  return (
    <div className="flex gap-1">
      {OPTIONS.map((opt) => {
        const selected = opt.value === value
        return (
          <button
            key={opt.value}
            type="button"
            aria-pressed={selected}
            onClick={() => onChange(opt.value)}
            className={`px-3 py-1 text-sm rounded border ${selected ? 'bg-primary text-primary-foreground' : 'bg-background'}`}
          >
            {opt.label}
          </button>
        )
      })}
    </div>
  )
}
