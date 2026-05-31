/**
 * Friendly recurrence picker (issue #297). Compiles to/from RRULE strings so
 * the storage format is unchanged. Supports daily, weekly (weekday multi-select),
 * monthly (by day-of-month), and yearly. Shows next 3 occurrences as a preview.
 *
 * "Show advanced (RRULE)" toggle exposes the raw text input for power users.
 */
import { useEffect, useMemo, useState } from 'react'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

type Frequency = 'none' | 'daily' | 'weekly' | 'monthly' | 'yearly'

const WEEKDAY_CODES = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'] as const
const WEEKDAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

type Props = {
  value: string
  onChange: (rrule: string) => void
  /** Anchor date (YYYY-MM-DD) for next-occurrence preview */
  anchorDate?: string
}

/** Parse a simple RRULE back into picker state. Returns null if too complex. */
function parseRRule(rrule: string): {
  freq: Frequency
  byDay: string[]
  byMonthDay: number | null
} | null {
  if (!rrule) return { freq: 'none', byDay: [], byMonthDay: null }
  const parts: Record<string, string> = {}
  for (const part of rrule.split(';')) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    parts[part.slice(0, eq).toUpperCase()] = part.slice(eq + 1)
  }
  const freq = parts['FREQ']?.toLowerCase() as Frequency | undefined
  if (!freq || !['daily', 'weekly', 'monthly', 'yearly'].includes(freq)) return null
  const byDay = parts['BYDAY'] ? parts['BYDAY'].split(',').map((d) => d.trim().toUpperCase()) : []
  const byMonthDay = parts['BYMONTHDAY'] ? parseInt(parts['BYMONTHDAY'], 10) : null
  return { freq, byDay, byMonthDay: Number.isNaN(byMonthDay ?? NaN) ? null : byMonthDay }
}

/** Build an RRULE string from picker state. */
function buildRRule(
  freq: Frequency,
  byDay: string[],
  byMonthDay: number | null,
): string {
  if (freq === 'none') return ''
  let rule = `FREQ=${freq.toUpperCase()}`
  if (freq === 'weekly' && byDay.length > 0) {
    rule += `;BYDAY=${byDay.join(',')}`
  }
  if (freq === 'monthly' && byMonthDay != null) {
    rule += `;BYMONTHDAY=${byMonthDay}`
  }
  return rule
}

/** Generate at most n ISO date strings from a simple RRULE starting after anchorDate. */
function nextDates(rrule: string, anchor: string, n: number): string[] {
  if (!rrule || !anchor) return []
  const parsed = parseRRule(rrule)
  if (!parsed || parsed.freq === 'none') return []
  const { freq, byDay, byMonthDay } = parsed

  const results: string[] = []
  const start = new Date(anchor + 'T00:00:00')
  const cursor = new Date(start)

  const advance = () => {
    if (freq === 'daily') cursor.setDate(cursor.getDate() + 1)
    else if (freq === 'weekly') cursor.setDate(cursor.getDate() + 1)
    else if (freq === 'monthly') {
      const targetDay = byMonthDay ?? start.getDate()
      cursor.setMonth(cursor.getMonth() + 1)
      const lastDay = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0).getDate()
      cursor.setDate(Math.min(targetDay, lastDay))
    }
    else if (freq === 'yearly') cursor.setFullYear(cursor.getFullYear() + 1)
  }

  advance()
  let safety = 0
  while (results.length < n && safety < 1000) {
    safety++
    const dayCode = WEEKDAY_CODES[cursor.getDay() === 0 ? 6 : cursor.getDay() - 1]
    const qualifies =
      freq === 'weekly'
        ? byDay.length === 0 || byDay.includes(dayCode)
        : true
    if (qualifies) {
      results.push(cursor.toISOString().slice(0, 10))
    }
    if (freq !== 'weekly' || results.length >= n) break
    advance()
  }
  return results
}

export function RecurrencePicker({ value, onChange, anchorDate }: Props) {
  const parsed = useMemo(() => parseRRule(value), [value])
  const [advanced, setAdvanced] = useState(parsed === null && Boolean(value))

  const [freq, setFreq] = useState<Frequency>(parsed?.freq ?? 'none')
  const [byDay, setByDay] = useState<string[]>(parsed?.byDay ?? [])
  const [byMonthDay, setByMonthDay] = useState<number | null>(parsed?.byMonthDay ?? null)

  // Sync picker state when external value changes (e.g. on edit load).
  useEffect(() => {
    const p = parseRRule(value)
    if (p) {
      setFreq(p.freq)
      setByDay(p.byDay)
      setByMonthDay(p.byMonthDay)
      setAdvanced(false)
    } else if (value) {
      setAdvanced(true)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function handleFreqChange(f: Frequency) {
    setFreq(f)
    onChange(buildRRule(f, byDay, byMonthDay))
  }

  function toggleDay(code: string) {
    const next = byDay.includes(code) ? byDay.filter((d) => d !== code) : [...byDay, code]
    setByDay(next)
    onChange(buildRRule(freq, next, byMonthDay))
  }

  function handleMonthDay(val: string) {
    const n = val ? parseInt(val, 10) : null
    const safe = n != null && n >= 1 && n <= 31 ? n : null
    setByMonthDay(safe)
    onChange(buildRRule(freq, byDay, safe))
  }

  const preview = useMemo(() => {
    if (!value || !anchorDate) return []
    return nextDates(value, anchorDate, 3)
  }, [value, anchorDate])

  if (advanced) {
    return (
      <div className="flex flex-col gap-1">
        <Input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="FREQ=MONTHLY;BYMONTHDAY=1"
        />
        <button
          type="button"
          onClick={() => {
            const p = parseRRule(value)
            if (p) { setFreq(p.freq); setByDay(p.byDay); setByMonthDay(p.byMonthDay) }
            setAdvanced(false)
          }}
          className="text-xs text-muted-foreground underline-offset-2 hover:underline text-left"
        >
          ← Use picker
        </button>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-2">
      <select
        className="border rounded px-2 py-1.5 text-sm"
        value={freq}
        onChange={(e) => handleFreqChange(e.target.value as Frequency)}
      >
        <option value="none">Does not repeat</option>
        <option value="daily">Daily</option>
        <option value="weekly">Weekly</option>
        <option value="monthly">Monthly</option>
        <option value="yearly">Yearly</option>
      </select>

      {freq === 'weekly' && (
        <div className="flex gap-1 flex-wrap">
          {WEEKDAY_CODES.map((code, i) => (
            <button
              key={code}
              type="button"
              onClick={() => toggleDay(code)}
              className={`rounded px-2 py-0.5 text-xs border transition-colors ${
                byDay.includes(code)
                  ? 'bg-primary text-primary-foreground border-primary'
                  : 'border-border text-muted-foreground hover:border-primary'
              }`}
            >
              {WEEKDAY_LABELS[i]}
            </button>
          ))}
        </div>
      )}

      {freq === 'monthly' && (
        <Label className="text-xs">
          On day of month
          <Input
            type="number"
            min="1"
            max="31"
            placeholder="1"
            value={byMonthDay ?? ''}
            onChange={(e) => handleMonthDay(e.target.value)}
            className="w-20"
          />
        </Label>
      )}

      {preview.length > 0 && (
        <p className="text-xs text-muted-foreground">
          Next: {preview.join(' · ')}
        </p>
      )}

      <button
        type="button"
        onClick={() => setAdvanced(true)}
        className="text-xs text-muted-foreground underline-offset-2 hover:underline text-left"
      >
        Advanced (RRULE) →
      </button>
    </div>
  )
}
