import { useEffect, useState } from 'react'
import { Input } from '@/components/ui/input'
import { NativeSelect } from '@/components/ui/native-select'
import { Button } from '@/components/ui/button'
import {
  serializeRRule,
  parseRRule,
  nextOccurrences,
  MONTH_NAMES,
  ORDINALS,
  type RRuleDay,
  type RRuleFreq,
  type RRuleState,
} from './rrule'

const FREQ_OPTIONS: Array<{ value: '' | RRuleFreq; label: string }> = [
  { value: '', label: 'Does not repeat' },
  { value: 'DAILY', label: 'Daily' },
  { value: 'WEEKLY', label: 'Weekly' },
  { value: 'MONTHLY', label: 'Monthly' },
  { value: 'YEARLY', label: 'Yearly' },
]

const WEEKDAYS: Array<{ day: RRuleDay; short: string; long: string }> = [
  { day: 'MO', short: 'M', long: 'Monday' },
  { day: 'TU', short: 'T', long: 'Tuesday' },
  { day: 'WE', short: 'W', long: 'Wednesday' },
  { day: 'TH', short: 'T', long: 'Thursday' },
  { day: 'FR', short: 'F', long: 'Friday' },
  { day: 'SA', short: 'S', long: 'Saturday' },
  { day: 'SU', short: 'S', long: 'Sunday' },
]

const ORDINAL_VALUES = [1, 2, 3, 4, -1]

type MonthlyMode = 'byDay' | 'byNthWeekday'

interface Props {
  value: string
  onChange: (rrule: string) => void
  expectedDate: string
  id: string
}

function stateFromRaw(raw: string): { state: RRuleState; advanced: boolean; exotic: boolean } {
  if (!raw) return { state: { freq: null }, advanced: false, exotic: false }
  const parsed = parseRRule(raw)
  if (parsed === null) return { state: { freq: null }, advanced: true, exotic: true }
  return { state: parsed, advanced: false, exotic: false }
}

export function RecurrencePicker({ value, onChange, expectedDate, id }: Props) {
  const prefixId = id
  const { state: initState, advanced: initAdvanced, exotic: initExotic } = stateFromRaw(value)

  const [freq, setFreqRaw] = useState<'' | RRuleFreq>(initState.freq ?? '')
  const [byDay, setByDay] = useState<RRuleDay[]>(initState.byDay ?? [])
  const [monthlyMode, setMonthlyMode] = useState<MonthlyMode>(
    initState.byDayNth ? 'byNthWeekday' : 'byDay',
  )
  const [byMonthDay, setByMonthDay] = useState(initState.byMonthDay ?? 1)
  const [byDayNthN, setByDayNthN] = useState(initState.byDayNth?.n ?? 1)
  const [byDayNthDay, setByDayNthDay] = useState<RRuleDay>(initState.byDayNth?.day ?? 'MO')
  const [byMonth, setByMonth] = useState(initState.byMonth ?? 1)
  const [byYearMonthDay, setByYearMonthDay] = useState(initState.byYearMonthDay ?? 1)

  const [showAdvanced, setShowAdvanced] = useState(initAdvanced)
  const [advancedRaw, setAdvancedRaw] = useState(initExotic ? value : '')
  const [advancedError, setAdvancedError] = useState('')

  const [weeklyError, setWeeklyError] = useState('')

  function buildState(): RRuleState {
    if (freq === '') return { freq: null }
    if (freq === 'WEEKLY') return { freq, byDay }
    if (freq === 'MONTHLY') {
      if (monthlyMode === 'byNthWeekday') {
        return { freq, byDayNth: { n: byDayNthN, day: byDayNthDay } }
      }
      return { freq, byMonthDay }
    }
    if (freq === 'YEARLY') {
      return { freq, byMonth, byYearMonthDay }
    }
    return { freq }
  }

  // Emit whenever core state changes (but not when advanced is active)
  useEffect(() => {
    if (showAdvanced) return
    const s = buildState()
    if (s.freq === 'WEEKLY' && (!s.byDay || s.byDay.length === 0)) {
      setWeeklyError('Pick at least one weekday.')
    } else {
      setWeeklyError('')
      onChange(serializeRRule(s))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [freq, byDay, monthlyMode, byMonthDay, byDayNthN, byDayNthDay, byMonth, byYearMonthDay])

  function toggleDay(day: RRuleDay) {
    setByDay((prev) =>
      prev.includes(day) ? prev.filter((d) => d !== day) : [...prev, day],
    )
  }

  function handleAdvancedBlur() {
    if (!advancedRaw.trim()) {
      setAdvancedError('')
      return
    }
    const parsed = parseRRule(advancedRaw.trim())
    if (parsed === null) {
      setAdvancedError('Invalid recurrence pattern')
      return
    }
    setAdvancedError('')
    // Reflect back into dropdowns
    setFreqRaw(parsed.freq ?? '')
    if (parsed.byDay) setByDay(parsed.byDay)
    if (parsed.byDayNth) { setMonthlyMode('byNthWeekday'); setByDayNthN(parsed.byDayNth.n); setByDayNthDay(parsed.byDayNth.day) }
    if (parsed.byMonthDay) setByMonthDay(parsed.byMonthDay)
    if (parsed.byMonth) setByMonth(parsed.byMonth)
    if (parsed.byYearMonthDay) setByYearMonthDay(parsed.byYearMonthDay)
    onChange(serializeRRule(parsed))
  }

  const currentState = showAdvanced && !advancedError && advancedRaw
    ? (parseRRule(advancedRaw.trim()) ?? buildState())
    : buildState()

  const occurrences = nextOccurrences(currentState, expectedDate, 3)

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <NativeSelect
          id={prefixId}
          value={freq}
          onChange={(e) => {
            setFreqRaw(e.target.value as '' | RRuleFreq)
            setWeeklyError('')
          }}
          aria-label="Recurrence frequency"
        >
          {FREQ_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </NativeSelect>
      </div>

      {freq === 'WEEKLY' && (
        <div className="flex flex-col gap-1">
          <div className="flex gap-1" role="group" aria-label="Weekdays">
            {WEEKDAYS.map(({ day, short, long }) => {
              const active = byDay.includes(day)
              return (
                <Button
                  key={day}
                  type="button"
                  variant={active ? 'default' : 'outline'}
                  size="sm"
                  aria-label={long}
                  aria-pressed={active}
                  onClick={() => toggleDay(day)}
                  className="h-7 w-7 rounded-full"
                >
                  {short}
                </Button>
              )
            })}
          </div>
          {weeklyError && (
            <p className="text-xs text-destructive">{weeklyError}</p>
          )}
        </div>
      )}

      {freq === 'MONTHLY' && (
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2 flex-wrap">
            <label className="flex items-center gap-1 text-sm cursor-pointer">
              <input
                type="radio"
                name={`${prefixId}-monthly-mode`}
                checked={monthlyMode === 'byDay'}
                onChange={() => setMonthlyMode('byDay')}
              />
              On day
              <Input
                type="number"
                min={1}
                max={31}
                className="w-16 h-7 px-1.5 text-sm ml-1"
                value={byMonthDay}
                disabled={monthlyMode !== 'byDay'}
                onChange={(e) => setByMonthDay(Number(e.target.value))}
                title="Months shorter than this day are skipped."
              />
              {byMonthDay === 31 && (
                <span className="text-xs text-muted-foreground">Months shorter than 31 days are skipped.</span>
              )}
            </label>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <label className="flex items-center gap-1 text-sm cursor-pointer">
              <input
                type="radio"
                name={`${prefixId}-monthly-mode`}
                checked={monthlyMode === 'byNthWeekday'}
                onChange={() => setMonthlyMode('byNthWeekday')}
              />
              On the
              <NativeSelect
                className="h-7 text-sm"
                value={byDayNthN}
                disabled={monthlyMode !== 'byNthWeekday'}
                onChange={(e) => setByDayNthN(Number(e.target.value))}
                aria-label="Ordinal"
              >
                {ORDINAL_VALUES.map((n, i) => (
                  <option key={n} value={n}>{ORDINALS[i]}</option>
                ))}
              </NativeSelect>
              <NativeSelect
                className="h-7 text-sm"
                value={byDayNthDay}
                disabled={monthlyMode !== 'byNthWeekday'}
                onChange={(e) => setByDayNthDay(e.target.value as RRuleDay)}
                aria-label="Weekday"
              >
                {WEEKDAYS.map(({ day, long }) => (
                  <option key={day} value={day}>{long}</option>
                ))}
              </NativeSelect>
            </label>
          </div>
        </div>
      )}

      {freq === 'YEARLY' && (
        <div className="flex items-center gap-2 flex-wrap text-sm">
          <span>On</span>
          <NativeSelect
            className="h-7 text-sm"
            value={byMonth}
            onChange={(e) => setByMonth(Number(e.target.value))}
            aria-label="Month"
          >
            {MONTH_NAMES.map((m, i) => (
              <option key={i + 1} value={i + 1}>{m}</option>
            ))}
          </NativeSelect>
          <Input
            type="number"
            min={1}
            max={31}
            className="w-16 h-7 px-1.5 text-sm"
            value={byYearMonthDay}
            onChange={(e) => setByYearMonthDay(Number(e.target.value))}
            aria-label="Day of month"
          />
          {byMonth === 2 && byYearMonthDay === 29 && (
            <span className="text-xs text-muted-foreground">Falls only in leap years.</span>
          )}
        </div>
      )}

      {freq && occurrences.length > 0 && (
        <p className="text-xs text-muted-foreground">
          Next 3 occurrences:{' '}
          {occurrences.join(', ')}
        </p>
      )}

      <div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-6 px-1 text-xs text-muted-foreground"
          onClick={() => setShowAdvanced((v) => !v)}
        >
          {showAdvanced ? 'Hide advanced' : 'Show advanced (RRULE)'}
        </Button>
        {showAdvanced && (
          <div className="mt-1">
            <Input
              type="text"
              className="font-mono text-xs"
              placeholder="RRULE:FREQ=MONTHLY;BYMONTHDAY=1"
              value={advancedRaw || (!initExotic ? serializeRRule(buildState()) : '')}
              onChange={(e) => {
                setAdvancedRaw(e.target.value)
                setAdvancedError('')
              }}
              onBlur={handleAdvancedBlur}
            />
            {advancedError && (
              <p className="text-xs text-destructive mt-0.5">{advancedError}</p>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
