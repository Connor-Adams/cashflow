const WEEKDAYS = [
  'Sundays',
  'Mondays',
  'Tuesdays',
  'Wednesdays',
  'Thursdays',
  'Fridays',
  'Saturdays',
]

function formatTime(hour: number, minute: number): string {
  const period = hour < 12 ? 'AM' : 'PM'
  const h = hour % 12 === 0 ? 12 : hour % 12
  return `${h}:${minute.toString().padStart(2, '0')} ${period}`
}

const isNum = (field: string) => /^\d+$/.test(field)
const stepOf = (field: string): number | null => {
  const match = /^\*\/(\d+)$/.exec(field)
  return match ? Number(match[1]) : null
}

/**
 * Turn a standard 5-field cron expression into a plain-English phrase.
 * Covers the patterns Cashflow's scheduled jobs actually use (every-N-minutes,
 * hourly, every-N-hours, daily-at-time, weekly-on-a-weekday). Anything outside
 * that set falls back to the raw expression so nothing is mislabeled.
 */
export function describeCron(cron: string | null): string {
  if (!cron) return 'Manual'
  const trimmed = cron.trim()
  if (trimmed === '' || trimmed === 'manual') return 'Manual'

  const parts = trimmed.split(/\s+/)
  if (parts.length !== 5) return cron
  const [min, hour, dom, mon, dow] = parts
  const everyDay = dom === '*' && mon === '*' && dow === '*'

  if (everyDay) {
    if (min === '*' && hour === '*') return 'Every minute'

    const minStep = stepOf(min)
    if (minStep !== null && hour === '*') {
      return minStep === 1 ? 'Every minute' : `Every ${minStep} minutes`
    }

    if (min === '0' && hour === '*') return 'Every hour'

    const hourStep = stepOf(hour)
    if (isNum(min) && hourStep !== null) {
      return hourStep === 1 ? 'Every hour' : `Every ${hourStep} hours`
    }

    if (isNum(min) && isNum(hour) && Number(min) < 60 && Number(hour) < 24) {
      return `Daily at ${formatTime(Number(hour), Number(min))}`
    }
  }

  // Weekly on a single weekday: M H * * D
  if (dom === '*' && mon === '*' && isNum(min) && isNum(hour) && isNum(dow)) {
    const m = Number(min)
    const h = Number(hour)
    const d = Number(dow) === 7 ? 0 : Number(dow)
    if (m < 60 && h < 24 && d >= 0 && d <= 6) {
      return `${WEEKDAYS[d]} at ${formatTime(h, m)}`
    }
  }

  return cron
}
