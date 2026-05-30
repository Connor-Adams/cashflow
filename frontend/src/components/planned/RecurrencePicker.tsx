import { useEffect, useState } from 'react'
import { Input } from '@/components/ui/input'
import { NativeSelect } from '@/components/ui/native-select'
import {
  computeNextOccurrences,
  parseRrule,
  serializeRrule,
  type PickerFrequency,
  type PickerState,
} from './rrule'

interface RecurrencePickerProps {
  value: string // current RRULE string (or '')
  onChange: (rrule: string) => void
  startDate?: string // YYYY-MM-DD for occurrence preview
}

const WEEKDAYS: { key: string; label: string }[] = [
  { key: 'MO', label: 'M' },
  { key: 'TU', label: 'T' },
  { key: 'WE', label: 'W' },
  { key: 'TH', label: 'T' },
  { key: 'FR', label: 'F' },
  { key: 'SA', label: 'S' },
  { key: 'SU', label: 'S' },
]

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
]

const ORDINAL_OPTIONS: { value: PickerState['byDayOrdinal']; label: string }[] =
  [
    { value: '1', label: '1st' },
    { value: '2', label: '2nd' },
    { value: '3', label: '3rd' },
    { value: '4', label: '4th' },
    { value: '-1', label: 'Last' },
  ]

const FREQ_OPTIONS: { value: PickerFrequency; label: string }[] = [
  { value: 'none', label: 'Does not repeat' },
  { value: 'daily', label: 'Daily' },
  { value: 'weekly', label: 'Weekly' },
  { value: 'monthly_day', label: 'Monthly' },
  { value: 'yearly', label: 'Yearly' },
]

function defaultStateForFreq(freq: PickerFrequency): PickerState {
  switch (freq) {
    case 'weekly':
      return { freq, weekdays: ['MO'] }
    case 'monthly_day':
      return { freq, byMonthDay: 1 }
    case 'monthly_weekday':
      return { freq, byDayOrdinal: '1', byDayWeekday: 'MO' }
    case 'yearly':
      return { freq, byMonth: 1, yearlyMonthDay: 1 }
    default:
      return { freq }
  }
}

export function RecurrencePicker({
  value,
  onChange,
  startDate,
}: RecurrencePickerProps) {
  // Parse initial value from prop
  const parsed = parseRrule(value)
  const isExotic = value !== '' && parsed === null

  const [pickerState, setPickerState] = useState<PickerState>(
    parsed ?? { freq: 'none' },
  )
  // Monthly sub-mode: 'day' or 'weekday'
  const [monthlyMode, setMonthlyMode] = useState<'day' | 'weekday'>('day')
  // Advanced mode state
  const [showAdvanced, setShowAdvanced] = useState(isExotic)
  const [advancedText, setAdvancedText] = useState(value)
  const [advancedError, setAdvancedError] = useState('')

  // Sync picker state when prop changes externally
  useEffect(() => {
    const p = parseRrule(value)
    if (p) {
      setPickerState(p)
      setAdvancedText(value)
      setAdvancedError('')
      if (p.freq === 'monthly_weekday') setMonthlyMode('weekday')
      else if (p.freq === 'monthly_day') setMonthlyMode('day')
      if (value !== '' && !showAdvanced) {
        // don't auto-show advanced unless exotic
      }
    } else if (value !== '') {
      // exotic — show advanced
      setAdvancedText(value)
      setShowAdvanced(true)
    } else {
      setPickerState({ freq: 'none' })
      setAdvancedText('')
      setAdvancedError('')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value])

  function emitState(state: PickerState) {
    // Validate before emitting
    if (state.freq === 'weekly' && (state.weekdays ?? []).length === 0) {
      // Don't emit — validation error shown separately
      return
    }
    const rrule = serializeRrule(state)
    onChange(rrule)
  }

  function handleFreqChange(freq: PickerFrequency) {
    // Map monthly_day/monthly_weekday to display freq 'monthly_day' in dropdown
    let newState: PickerState
    if (freq === 'monthly_day') {
      if (monthlyMode === 'weekday') {
        newState = defaultStateForFreq('monthly_weekday')
      } else {
        newState = defaultStateForFreq('monthly_day')
      }
    } else {
      newState = defaultStateForFreq(freq)
    }
    setPickerState(newState)
    emitState(newState)
  }

  function toggleWeekday(key: string) {
    const current = pickerState.weekdays ?? []
    const next = current.includes(key)
      ? current.filter((d) => d !== key)
      : [...current, key]
    const newState: PickerState = { ...pickerState, weekdays: next }
    setPickerState(newState)
    emitState(newState)
  }

  function handleMonthlyModeChange(mode: 'day' | 'weekday') {
    setMonthlyMode(mode)
    const newState: PickerState =
      mode === 'weekday'
        ? { freq: 'monthly_weekday', byDayOrdinal: '1', byDayWeekday: 'MO' }
        : { freq: 'monthly_day', byMonthDay: 1 }
    setPickerState(newState)
    emitState(newState)
  }

  function handleAdvancedTextChange(text: string) {
    setAdvancedText(text)
    if (text.trim() === '') {
      setAdvancedError('')
      onChange('')
      setPickerState({ freq: 'none' })
      return
    }
    const p = parseRrule(text)
    if (p) {
      setAdvancedError('')
      setPickerState(p)
      onChange(text)
    } else {
      setAdvancedError('Invalid recurrence pattern')
      // Do not call onChange for invalid input
    }
  }

  // Determine the display frequency for the dropdown
  const displayFreq: PickerFrequency =
    pickerState.freq === 'monthly_weekday' ? 'monthly_day' : pickerState.freq

  // Compute occurrences preview
  const rruleForPreview = serializeRrule(pickerState)
  const occurrences =
    pickerState.freq !== 'none' && startDate && rruleForPreview
      ? computeNextOccurrences(rruleForPreview, startDate, 3)
      : []

  // Weekly validation error
  const weeklyError =
    pickerState.freq === 'weekly' && (pickerState.weekdays ?? []).length === 0
      ? 'Pick at least one weekday.'
      : ''

  return (
    <div className="flex flex-col gap-2">
      {/* Frequency selector */}
      <NativeSelect
        value={displayFreq}
        onChange={(e) => handleFreqChange(e.target.value as PickerFrequency)}
        aria-label="Recurrence frequency"
      >
        {FREQ_OPTIONS.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </NativeSelect>

      {/* Weekly sub-controls */}
      {pickerState.freq === 'weekly' && (
        <div className="flex flex-col gap-1">
          <div className="flex gap-1">
            {WEEKDAYS.map((wd) => {
              const active = (pickerState.weekdays ?? []).includes(wd.key)
              return (
                <button
                  key={wd.key}
                  type="button"
                  onClick={() => toggleWeekday(wd.key)}
                  aria-pressed={active}
                  aria-label={wd.key}
                  className={[
                    'flex h-8 w-8 items-center justify-center rounded-full text-xs font-medium transition-colors',
                    active
                      ? 'bg-primary text-primary-foreground'
                      : 'border border-input bg-background/70 text-foreground hover:bg-muted',
                  ].join(' ')}
                >
                  {wd.label}
                </button>
              )
            })}
          </div>
          {weeklyError && (
            <p className="text-xs text-destructive">{weeklyError}</p>
          )}
        </div>
      )}

      {/* Monthly sub-controls */}
      {(pickerState.freq === 'monthly_day' ||
        pickerState.freq === 'monthly_weekday') && (
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-3">
            <label className="flex items-center gap-1.5 text-sm">
              <input
                type="radio"
                name="monthly-mode"
                checked={monthlyMode === 'day'}
                onChange={() => handleMonthlyModeChange('day')}
                className="accent-primary"
              />
              On day
            </label>
            {monthlyMode === 'day' && (
              <Input
                type="number"
                min={1}
                max={31}
                value={pickerState.byMonthDay ?? 1}
                onChange={(e) => {
                  const day = Math.min(
                    31,
                    Math.max(1, parseInt(e.target.value, 10) || 1),
                  )
                  const newState: PickerState = {
                    ...pickerState,
                    freq: 'monthly_day',
                    byMonthDay: day,
                  }
                  setPickerState(newState)
                  emitState(newState)
                }}
                className="w-20"
              />
            )}
          </div>
          <div className="flex items-center gap-1.5 flex-wrap">
            <label className="flex items-center gap-1.5 text-sm">
              <input
                type="radio"
                name="monthly-mode"
                checked={monthlyMode === 'weekday'}
                onChange={() => handleMonthlyModeChange('weekday')}
                className="accent-primary"
              />
              On the
            </label>
            {monthlyMode === 'weekday' && (
              <>
                <NativeSelect
                  size="sm"
                  value={pickerState.byDayOrdinal ?? '1'}
                  onChange={(e) => {
                    const newState: PickerState = {
                      ...pickerState,
                      freq: 'monthly_weekday',
                      byDayOrdinal: e.target.value as PickerState['byDayOrdinal'],
                    }
                    setPickerState(newState)
                    emitState(newState)
                  }}
                  aria-label="Ordinal"
                >
                  {ORDINAL_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </NativeSelect>
                <NativeSelect
                  size="sm"
                  value={pickerState.byDayWeekday ?? 'MO'}
                  onChange={(e) => {
                    const newState: PickerState = {
                      ...pickerState,
                      freq: 'monthly_weekday',
                      byDayWeekday: e.target.value,
                    }
                    setPickerState(newState)
                    emitState(newState)
                  }}
                  aria-label="Weekday"
                >
                  {WEEKDAYS.map((wd) => (
                    <option key={wd.key} value={wd.key}>
                      {wd.key}
                    </option>
                  ))}
                </NativeSelect>
              </>
            )}
          </div>
        </div>
      )}

      {/* Yearly sub-controls */}
      {pickerState.freq === 'yearly' && (
        <div className="flex items-center gap-2 flex-wrap">
          <NativeSelect
            size="sm"
            value={pickerState.byMonth ?? 1}
            onChange={(e) => {
              const newState: PickerState = {
                ...pickerState,
                byMonth: parseInt(e.target.value, 10),
              }
              setPickerState(newState)
              emitState(newState)
            }}
            aria-label="Month"
          >
            {MONTH_NAMES.map((name, idx) => (
              <option key={idx + 1} value={idx + 1}>
                {name}
              </option>
            ))}
          </NativeSelect>
          <Input
            type="number"
            min={1}
            max={31}
            value={pickerState.yearlyMonthDay ?? 1}
            onChange={(e) => {
              const day = Math.min(
                31,
                Math.max(1, parseInt(e.target.value, 10) || 1),
              )
              const newState: PickerState = {
                ...pickerState,
                yearlyMonthDay: day,
              }
              setPickerState(newState)
              emitState(newState)
            }}
            className="w-20"
            aria-label="Day of month"
          />
        </div>
      )}

      {/* Next occurrences preview */}
      {occurrences.length > 0 && (
        <p className="text-xs text-muted-foreground">
          Next {occurrences.length === 1 ? 'occurrence' : 'occurrences'}:{' '}
          {occurrences.join(', ')}
        </p>
      )}

      {/* Advanced RRULE toggle */}
      <div>
        <button
          type="button"
          onClick={() => setShowAdvanced((v) => !v)}
          className="text-xs text-muted-foreground underline-offset-2 hover:underline"
        >
          {showAdvanced ? 'Hide advanced (RRULE)' : 'Show advanced (RRULE)'}
        </button>
        {showAdvanced && (
          <div className="mt-1 flex flex-col gap-1">
            <Input
              value={advancedText}
              onChange={(e) => handleAdvancedTextChange(e.target.value)}
              placeholder="FREQ=MONTHLY;BYMONTHDAY=1"
              className="font-mono text-xs"
              aria-label="RRULE string"
            />
            {advancedError && (
              <p className="text-xs text-destructive">{advancedError}</p>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
