import { useEffect, useState } from 'react'
import {
  WEEKDAY_CODES,
  WEEKDAY_LABELS,
  WEEKDAY_ARIA,
  defaultState,
  serialize,
  parse,
  nextOccurrences,
  type PickerState,
  type WeekdayCode,
} from './rrule'

const FREQ_OPTIONS = [
  { value: 'NONE', label: 'Does not repeat' },
  { value: 'DAILY', label: 'Daily' },
  { value: 'WEEKLY', label: 'Weekly' },
  { value: 'MONTHLY', label: 'Monthly' },
  { value: 'YEARLY', label: 'Yearly' },
] as const

const ORDINAL_OPTIONS = [
  { value: 1, label: '1st' },
  { value: 2, label: '2nd' },
  { value: 3, label: '3rd' },
  { value: 4, label: '4th' },
  { value: -1, label: 'Last' },
] as const

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]

type Props = {
  value: string
  onChange: (rrule: string) => void
  /** The expectedDate from the form, used for preview computation */
  expectedDate: string
}

export function RecurrencePicker({ value, onChange, expectedDate }: Props) {
  const [state, setState] = useState<PickerState>(defaultState)
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [advancedText, setAdvancedText] = useState('')
  const [advancedError, setAdvancedError] = useState<string | null>(null)

  // Sync incoming value → internal state
  useEffect(() => {
    if (!value) {
      setState(defaultState())
      setAdvancedText('')
      setShowAdvanced(false)
      return
    }
    const result = parse(value)
    if (result.kind === 'picker') {
      setState(result.state)
      setAdvancedText(value)
      setShowAdvanced(false)
    } else if (result.kind === 'advanced') {
      setAdvancedText(value)
      setShowAdvanced(true)
    }
  }, [value])

  const update = (patch: Partial<PickerState>) => {
    const next = { ...state, ...patch }
    setState(next)
    onChange(serialize(next))
  }

  const handleAdvancedChange = (raw: string) => {
    setAdvancedText(raw)
    if (!raw.trim()) {
      setAdvancedError(null)
      onChange('')
      return
    }
    const result = parse(raw)
    if (result.kind === 'picker') {
      setState(result.state)
      setAdvancedError(null)
      onChange(serialize(result.state))
    } else if (result.kind === 'advanced') {
      setAdvancedError(null)
      onChange(raw)
    } else {
      setAdvancedError('Invalid recurrence pattern')
    }
  }

  const preview = nextOccurrences(value, expectedDate, 3)

  const isWeeklyError = state.freq === 'WEEKLY' && state.byDay.length === 0

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
      {/* Frequency dropdown */}
      <select
        aria-label="Recurrence frequency"
        value={state.freq}
        onChange={(e) => {
          const freq = e.target.value as PickerState['freq']
          update({ freq })
          setShowAdvanced(false)
        }}
        className="rounded border px-2 py-1 text-sm"
      >
        {FREQ_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>

      {/* Weekly: weekday chips */}
      {state.freq === 'WEEKLY' && !showAdvanced && (
        <div style={{ display: 'flex', gap: '0.25rem', flexWrap: 'wrap' }}>
          {WEEKDAY_CODES.map((wd) => {
            const selected = state.byDay.includes(wd)
            return (
              <button
                key={wd}
                type="button"
                aria-label={WEEKDAY_ARIA[wd]}
                aria-pressed={selected}
                onClick={() => {
                  const next = selected
                    ? state.byDay.filter((d) => d !== wd)
                    : [...state.byDay, wd]
                  update({ byDay: next as WeekdayCode[] })
                }}
                className={`rounded px-2 py-0.5 text-xs font-medium border ${
                  selected
                    ? 'bg-primary text-primary-foreground border-primary'
                    : 'bg-background border-border'
                }`}
              >
                {WEEKDAY_LABELS[wd]}
              </button>
            )
          })}
          {isWeeklyError && (
            <p className="text-xs text-destructive" role="alert">
              Pick at least one weekday.
            </p>
          )}
        </div>
      )}

      {/* Monthly: by day or by weekday position */}
      {state.freq === 'MONTHLY' && !showAdvanced && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
          <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
            <label className="text-sm">
              <input
                type="radio"
                name="monthly-mode"
                value="bymonthday"
                checked={state.monthlyMode === 'bymonthday'}
                onChange={() => update({ monthlyMode: 'bymonthday' })}
              />{' '}
              On day
            </label>
            {state.monthlyMode === 'bymonthday' && (
              <input
                type="number"
                min={1}
                max={31}
                value={state.byMonthDay}
                onChange={(e) => update({ byMonthDay: Math.min(31, Math.max(1, parseInt(e.target.value, 10) || 1)) })}
                className="w-16 rounded border px-2 py-0.5 text-sm"
              />
            )}
            {state.byMonthDay === 31 && state.monthlyMode === 'bymonthday' && (
              <span className="text-xs text-muted-foreground" title="Months shorter than 31 days are skipped.">
                (skips short months)
              </span>
            )}
          </div>
          <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
            <label className="text-sm">
              <input
                type="radio"
                name="monthly-mode"
                value="byweekday"
                checked={state.monthlyMode === 'byweekday'}
                onChange={() => update({ monthlyMode: 'byweekday' })}
              />{' '}
              On the
            </label>
            {state.monthlyMode === 'byweekday' && (
              <>
                <select
                  aria-label="Ordinal"
                  value={state.weekdayOrdinal}
                  onChange={(e) => update({ weekdayOrdinal: parseInt(e.target.value, 10) as 1 | 2 | 3 | 4 | -1 })}
                  className="rounded border px-1 py-0.5 text-sm"
                >
                  {ORDINAL_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
                <select
                  aria-label="Weekday"
                  value={state.weekdayCode}
                  onChange={(e) => update({ weekdayCode: e.target.value as WeekdayCode })}
                  className="rounded border px-1 py-0.5 text-sm"
                >
                  {WEEKDAY_CODES.map((wd) => (
                    <option key={wd} value={wd}>{WEEKDAY_ARIA[wd]}</option>
                  ))}
                </select>
              </>
            )}
          </div>
        </div>
      )}

      {/* Yearly: month + day */}
      {state.freq === 'YEARLY' && !showAdvanced && (
        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
          <span className="text-sm">On</span>
          <select
            aria-label="Month"
            value={state.byMonth}
            onChange={(e) => update({ byMonth: parseInt(e.target.value, 10) })}
            className="rounded border px-1 py-0.5 text-sm"
          >
            {MONTH_NAMES.map((m, i) => (
              <option key={m} value={i + 1}>{m}</option>
            ))}
          </select>
          <input
            type="number"
            min={1}
            max={31}
            value={state.byYearDay}
            onChange={(e) => update({ byYearDay: Math.min(31, Math.max(1, parseInt(e.target.value, 10) || 1)) })}
            className="w-16 rounded border px-2 py-0.5 text-sm"
            aria-label="Day of month"
          />
          {state.byMonth === 2 && state.byYearDay === 29 && (
            <span className="text-xs text-muted-foreground" title="Falls only in leap years.">
              (leap years only)
            </span>
          )}
        </div>
      )}

      {/* Advanced toggle */}
      {state.freq !== 'NONE' && (
        <button
          type="button"
          className="text-xs text-muted-foreground underline self-start"
          onClick={() => setShowAdvanced((v) => !v)}
        >
          {showAdvanced ? 'Hide advanced (RRULE)' : 'Show advanced (RRULE)'}
        </button>
      )}

      {/* Advanced text input */}
      {showAdvanced && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
          <input
            type="text"
            value={advancedText}
            onChange={(e) => handleAdvancedChange(e.target.value)}
            placeholder="FREQ=MONTHLY;BYMONTHDAY=1"
            className="rounded border px-2 py-1 text-sm font-mono"
            aria-label="RRULE advanced input"
          />
          {advancedError && (
            <p className="text-xs text-destructive" role="alert">{advancedError}</p>
          )}
        </div>
      )}

      {/* Preview */}
      {preview.length > 0 && (
        <div className="text-xs text-muted-foreground">
          Next 3 occurrences: {preview.join(', ')}
        </div>
      )}
    </div>
  )
}
