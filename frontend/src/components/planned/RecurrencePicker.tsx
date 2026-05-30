import { useState, useEffect } from 'react'
import { parseRRule, serializeRRule, nextOccurrences, WEEKDAY_LABELS, WEEKDAY_DISPLAY, WEEKDAY_ARIA } from './rrule'
import type { Frequency, Weekday, ParsedRRule } from './rrule'

interface Props {
  value: string;
  onChange: (rrule: string) => void;
  startDate?: string;
}

export function RecurrencePicker({ value, onChange, startDate }: Props) {
  const [parsed, setParsed] = useState<ParsedRRule>(() => parseRRule(value))
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [advancedText, setAdvancedText] = useState(value)
  const [advancedError, setAdvancedError] = useState(false)

  useEffect(() => {
    const p = parseRRule(value)
    setParsed(p)
    setAdvancedText(value)
    if (p.raw) setShowAdvanced(true)
  }, [value])

  function update(next: ParsedRRule) {
    setParsed(next)
    const serialized = serializeRRule(next)
    setAdvancedText(serialized)
    onChange(serialized)
  }

  const preview = startDate ? nextOccurrences(parsed, startDate, 3) : []

  const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
  const ORDINALS = [{v: 1, l: '1st'}, {v: 2, l: '2nd'}, {v: 3, l: '3rd'}, {v: 4, l: '4th'}, {v: -1, l: 'Last'}]

  return (
    <div className="space-y-3">
      {/* Frequency select */}
      <div>
        <label className="block text-sm font-medium mb-1">Repeats</label>
        <select
          className="border rounded px-2 py-1 text-sm"
          value={parsed.raw ? 'advanced' : parsed.freq}
          onChange={e => {
            const freq = e.target.value as Frequency | 'advanced'
            if (freq === 'advanced') { setShowAdvanced(true); return; }
            update({ freq })
          }}
        >
          <option value="none">Does not repeat</option>
          <option value="daily">Daily</option>
          <option value="weekly">Weekly</option>
          <option value="monthly">Monthly</option>
          <option value="yearly">Yearly</option>
        </select>
      </div>

      {/* Weekly: weekday chips */}
      {parsed.freq === 'weekly' && !parsed.raw && (
        <div className="flex gap-1">
          {WEEKDAY_LABELS.map(day => (
            <button
              key={day}
              type="button"
              aria-label={WEEKDAY_ARIA[day]}
              className={`w-8 h-8 rounded-full text-xs font-medium border ${
                parsed.byDay?.includes(day) ? 'bg-blue-600 text-white border-blue-600' : 'bg-white border-gray-300'
              }`}
              onClick={() => {
                const curr = parsed.byDay ?? []
                const next = curr.includes(day) ? curr.filter(d => d !== day) : [...curr, day]
                update({ ...parsed, byDay: next })
              }}
            >
              {WEEKDAY_DISPLAY[day]}
            </button>
          ))}
        </div>
      )}

      {/* Monthly: day or weekday position */}
      {parsed.freq === 'monthly' && !parsed.raw && (
        <div className="space-y-2">
          <div className="flex gap-2 items-center">
            <label className="text-sm">
              <input type="radio" name="monthly-type" className="mr-1"
                checked={!!parsed.byMonthDay || (!parsed.byWeekdayPos)}
                onChange={() => update({ ...parsed, byMonthDay: parsed.byMonthDay ?? 1, byWeekdayPos: undefined })}
              />
              On day
            </label>
            <input
              type="number" min={1} max={31}
              className="border rounded px-2 py-1 text-sm w-16"
              value={parsed.byMonthDay ?? 1}
              onChange={e => update({ ...parsed, byMonthDay: Math.min(31, Math.max(1, parseInt(e.target.value) || 1)), byWeekdayPos: undefined })}
            />
          </div>
          <div className="flex gap-2 items-center flex-wrap">
            <label className="text-sm">
              <input type="radio" name="monthly-type" className="mr-1"
                checked={!!parsed.byWeekdayPos}
                onChange={() => update({ ...parsed, byMonthDay: undefined, byWeekdayPos: { ordinal: 1, day: 'MO' } })}
              />
              On the
            </label>
            <select className="border rounded px-1 py-1 text-sm"
              value={parsed.byWeekdayPos?.ordinal ?? 1}
              onChange={e => update({ ...parsed, byMonthDay: undefined, byWeekdayPos: { ordinal: parseInt(e.target.value), day: parsed.byWeekdayPos?.day ?? 'MO' } })}
            >
              {ORDINALS.map(o => <option key={o.v} value={o.v}>{o.l}</option>)}
            </select>
            <select className="border rounded px-1 py-1 text-sm"
              value={parsed.byWeekdayPos?.day ?? 'MO'}
              onChange={e => update({ ...parsed, byMonthDay: undefined, byWeekdayPos: { ordinal: parsed.byWeekdayPos?.ordinal ?? 1, day: e.target.value as Weekday } })}
            >
              {WEEKDAY_LABELS.map(d => <option key={d} value={d}>{WEEKDAY_ARIA[d]}</option>)}
            </select>
          </div>
        </div>
      )}

      {/* Yearly: month + day */}
      {parsed.freq === 'yearly' && !parsed.raw && (
        <div className="flex gap-2 items-center">
          <span className="text-sm">On</span>
          <select className="border rounded px-1 py-1 text-sm"
            value={parsed.byMonth ?? 1}
            onChange={e => update({ ...parsed, byMonth: parseInt(e.target.value), yearlyDay: parsed.yearlyDay ?? 1 })}
          >
            {MONTHS.map((m, i) => <option key={i+1} value={i+1}>{m}</option>)}
          </select>
          <input type="number" min={1} max={31} className="border rounded px-2 py-1 text-sm w-16"
            value={parsed.yearlyDay ?? 1}
            onChange={e => update({ ...parsed, yearlyDay: Math.min(31, Math.max(1, parseInt(e.target.value) || 1)) })}
          />
        </div>
      )}

      {/* Advanced toggle */}
      {!showAdvanced && (
        <button type="button" className="text-sm text-blue-600 hover:underline"
          onClick={() => setShowAdvanced(true)}>
          Show advanced (RRULE)
        </button>
      )}

      {showAdvanced && (
        <div>
          <input
            className={`border rounded px-2 py-1 text-sm w-full font-mono ${advancedError ? 'border-red-500' : ''}`}
            value={advancedText}
            placeholder="RRULE:FREQ=..."
            onChange={e => {
              setAdvancedText(e.target.value)
              const p = parseRRule(e.target.value)
              if (!p.raw || e.target.value === '' || e.target.value.startsWith('RRULE:')) {
                setAdvancedError(false)
                setParsed(p)
                onChange(serializeRRule(p))
              } else {
                setAdvancedError(true)
              }
            }}
          />
          {advancedError && <p className="text-xs text-red-600 mt-1">Invalid recurrence pattern</p>}
        </div>
      )}

      {/* Preview */}
      {preview.length > 0 && (
        <div className="text-sm text-gray-500">
          <span className="font-medium">Next {preview.length} occurrence{preview.length > 1 ? 's' : ''}:</span>{' '}
          {preview.join(', ')}
        </div>
      )}
    </div>
  )
}
